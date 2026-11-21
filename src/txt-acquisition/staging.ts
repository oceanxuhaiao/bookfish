/**
 * Dedicated staging area for acquired files: <dataDir>/bookfish/txt-acquisition.
 * Raw downloaded bytes never go into the book body directory, and a retained
 * file stays available after a failed import so the work can be retried.
 */
import { createReadStream, createWriteStream, lstatSync, realpathSync, mkdirSync, rmSync, writeFileSync, openSync } from 'node:fs';
import { link, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile, lstat, realpath, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, sep, dirname } from 'node:path';
import type { FileFormat } from './types.ts';

export class OriginalFileError extends Error {
  constructor(readonly code: 'original_integrity' | 'storage_unavailable', message: string) { super(message); }
}

export interface MaintenanceResult {
  status: 'success' | 'skipped_active_tasks' | 'over_quota_referenced' | 'permission_denied' | 'disk_unavailable' | 'cleanup_failed';
  removed: string[];
  usageBytes?: number;
  limitBytes?: number;
  errorCode?: string;
}

export function maintenanceFailure(error: unknown, removed: string[] = []): MaintenanceResult {
  const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
  return { status: ['EACCES', 'EPERM', 'EROFS'].includes(code) ? 'permission_denied' : ['EIO', 'ENODEV', 'ENOSPC', 'ENOENT'].includes(code) ? 'disk_unavailable' : 'cleanup_failed', removed, errorCode: code };
}

const rawTransactions = new Map<string, Promise<unknown>>();
export class AcquisitionStaging {
  readonly rawDir: string;
  readonly workDir: string;
  private readonly directoryIds = new Map<string,string>();

  constructor(readonly root: string) {
    this.root = resolve(root);
    this.rawDir = join(this.root, 'raw');
    this.workDir = join(this.root, 'work');
  }

  /** No JS suspension between the final directory check and a synchronous mutation.
   * Node has no portable handle-relative unlink/openat on Windows: a hostile local
   * process racing the OS call itself remains outside this process-level guarantee.
   */
  assertSafeDirectories(allowMissing=false): void {
    const same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
    const paths=new Set<string>([this.rawDir,this.workDir]);let current=this.root;
    for(;;){paths.add(current);const parent=dirname(current);if(parent===current)break;current=parent;}
    for(const path of [...paths].sort((a,b)=>a.length-b.length)){
      let info;try{info=lstatSync(path);}catch(error){if(allowMissing&&!this.directoryIds.has(path)&&(error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      if(!info.isDirectory()||info.isSymbolicLink()||!same(resolve(realpathSync(path)),resolve(path)))throw new OriginalFileError('original_integrity','Staging directory is redirected or not a directory');
      const id=info.dev+':'+info.ino,previous=this.directoryIds.get(path);
      if(previous&&previous!==id)throw new OriginalFileError('original_integrity','Staging directory identity changed');
      this.directoryIds.set(path,id);
    }
  }

  async withRawLock<T>(operation:()=>Promise<T>|T):Promise<T>{
    const key=process.platform==='win32'?this.root.toLowerCase():this.root;
    const previous=rawTransactions.get(key)??Promise.resolve();let release!:()=>void;
    const next=new Promise<void>(done=>{release=done;});rawTransactions.set(key,next);
    try{await previous;this.assertSafeDirectories();return await operation();}
    finally{release();if(rawTransactions.get(key)===next)rawTransactions.delete(key);}
  }

  async init(): Promise<void> {
    this.initializeDirectories();
  }
  initializeDirectories():void{
    this.assertSafeDirectories(true);mkdirSync(this.root,{recursive:true,mode:0o700});
    this.assertSafeDirectories(true);mkdirSync(this.rawDir,{recursive:true,mode:0o700});
    this.assertSafeDirectories(true);mkdirSync(this.workDir,{recursive:true,mode:0o700});this.assertSafeDirectories();
  }

  /** Mount owns the library writer lock and no acquisition is running yet. */
  async clearAbandonedPrepared(): Promise<void> {
    this.assertSafeDirectories();
    for (const name of await readdir(this.workDir)) {
      if (/^[a-f0-9-]{36}\.verified\.txt(?:\.[a-f0-9-]{36}\.prepared\.txt)?$/u.test(name) || /^[a-f0-9-]{36}\.prepared\.txt$/u.test(name)) {this.assertSafeDirectories();const file=join(this.workDir,name);if(!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink())throw new OriginalFileError('original_integrity','Unsafe work file');rmSync(file);}
    }
  }

  /** Guard every derived path against traversal outside the acquisition root. */
  resolveInside(relative: string): string {
    const absolute = resolve(this.root, relative);
    if (absolute !== this.root && !absolute.startsWith(this.root + sep)) throw new Error('Staging path escapes the acquisition directory');
    return absolute;
  }

  /** Decode an authenticated private snapshot, never a path that can change after verification. */
  async verifiedOriginal(file: { path?: string; sha256: string; bytes: number }): Promise<string> {
    let snapshot: string | undefined;
    try {
      this.assertSafeDirectories();
      if (!file.path || !/^raw[\\/][a-f0-9]{64}\.(txt|md)$/u.test(file.path) || !file.path.includes(file.sha256 + '.')) throw new OriginalFileError('original_integrity', 'Original path does not match its recorded digest');
      const source = this.resolveInside(file.path);
      for (const dir of [this.root, this.rawDir, this.workDir]) if ((await lstat(dir)).isSymbolicLink() || resolve(await realpath(dir)) !== resolve(dir)) throw new OriginalFileError('original_integrity', 'Original storage directory is redirected');
      const before = await lstat(source);
      if (!before.isFile() || before.isSymbolicLink() || before.size !== file.bytes) throw new OriginalFileError('original_integrity', 'Original is not a regular file of the recorded size');
      const input = await open(source, 'r');
      try {
        const opened = await input.stat();
        if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) throw new OriginalFileError('original_integrity', 'Original changed before it could be opened');
        snapshot = this.resolveInside(join('work', randomUUID() + '.verified.txt'));
        this.assertSafeDirectories();const output = await open(snapshot, 'wx',0o600);
        const hash = createHash('sha256'); let bytes = 0;
        try {
          const buffer = Buffer.alloc(64 * 1024); let n: number;
          while ((n = (await input.read(buffer, 0, buffer.length, null)).bytesRead)) {
            bytes += n; if (bytes > file.bytes) throw new OriginalFileError('original_integrity', 'Original grew during verification');
            hash.update(buffer.subarray(0, n)); let at = 0;
            while (at < n) { const written = (await output.write(buffer, at, n - at)).bytesWritten; if (!written) throw new Error('Original snapshot write made no progress'); at += written; }
          }
          await output.sync();
        } finally { await output.close(); }
        const after = await input.stat();
        if (bytes !== file.bytes || hash.digest('hex') !== file.sha256 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new OriginalFileError('original_integrity', 'Original checksum or identity changed; reacquire the file');
        return snapshot;
      } finally { await input.close(); }
    } catch (error) {
      if (snapshot) await this.removeIfPresent(snapshot);
      if (error instanceof OriginalFileError) throw error;
      throw new OriginalFileError('storage_unavailable', 'Cannot read or verify the retained original (' + ((error as NodeJS.ErrnoException).code ?? 'I/O error') + ')');
    }
  }

  partialPath(taskId: string): string {
    this.assertSafeDirectories();
    return this.resolveInside(join('work', `${taskId}.part`));
  }

  preparedPath(taskId: string): string {
    this.assertSafeDirectories();
    return this.resolveInside(join('work', `${taskId}.prepared.txt`));
  }

  async writePrepared(taskId: string, text: string): Promise<string> {
    const target = this.preparedPath(taskId);
    this.assertSafeDirectories();writeFileSync(target,text,{encoding:'utf8',mode:0o600});
    return target;
  }

  async removeIfPresent(path: string): Promise<void> {
    try {
      if(!resolve(path).startsWith(this.root+sep))throw new OriginalFileError('original_integrity','Cleanup escapes staging');
      this.assertSafeDirectories();rmSync(path,{force:true});
    } catch { /* best effort */ }
  }

  /** Move a completed download into raw/<sha256>.<format>. */
  async commitRaw(temporary: string, sha256: string, format: FileFormat, publish?:(relative:string,phase:'pending'|'committed')=>void): Promise<string> {
    return this.withRawLock(()=>this.commitRawLocked(temporary,sha256,format,publish));
  }
  private async commitRawLocked(temporary:string,sha256:string,format:FileFormat,publish?: (relative:string,phase:'pending'|'committed')=>void):Promise<string>{
    this.assertSafeDirectories();
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('Invalid raw file digest');
    if (!resolve(temporary).startsWith(resolve(this.workDir) + sep) || !(await lstat(temporary)).isFile() || (await lstat(temporary)).isSymbolicLink() || resolve(await realpath(temporary)) !== resolve(temporary)) throw new OriginalFileError('original_integrity', 'Untrusted download work file');
    const relative = join('raw', sha256 + '.' + format);
    const target = this.resolveInside(relative);
    const input=await open(temporary,'r');let created=false;
    try{
    const identity=await input.stat();
    if ((await this.hashFile(temporary,input.fd)).sha256 !== sha256) throw new OriginalFileError('original_integrity','Staged file checksum mismatch');
    const matches=(path:string)=>{const info=lstatSync(path);return info.isFile()&&!info.isSymbolicLink()&&info.ino===identity.ino&&info.dev===identity.dev&&info.size===identity.size&&info.mtimeMs===identity.mtimeMs;};
    this.assertSafeDirectories();if(!matches(temporary))throw new OriginalFileError('original_integrity','Staged file was replaced after hashing');
    publish?.(relative,'pending');
    try { this.assertSafeDirectories();await link(temporary, target);created=true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if ((await lstat(target)).isSymbolicLink() || !(await lstat(target)).isFile()) throw new OriginalFileError('original_integrity', 'Existing original is not a regular file');
      if ((await this.hashFile(target)).sha256 !== sha256) throw new Error('Existing original file checksum mismatch');
    }
    this.assertSafeDirectories();
    if(created&&(!matches(target)||(await this.hashFile(target)).sha256!==sha256)){this.assertSafeDirectories();rmSync(target,{force:true});throw new OriginalFileError('original_integrity','Raw link changed during commit');}
    publish?.(relative,'committed');
    this.assertSafeDirectories();if(!matches(temporary))throw new OriginalFileError('original_integrity','Work file changed during commit');rmSync(temporary,{force:true});
    return relative;
    }finally{await input.close();}
  }

  async hashFile(path: string, fd?:number): Promise<{ sha256: string; bytes: number }> {
    this.assertSafeDirectories();
    const hash = createHash('sha256');
    let bytes = 0;
    await new Promise<void>((done, fail) => {
      const stream = createReadStream(path,fd===undefined?undefined:{fd,autoClose:false,start:0});
      stream.on('data', (chunk) => { hash.update(chunk); bytes += chunk.length; });
      stream.on('error', fail);
      stream.on('end', () => done());
    });
    return { sha256: hash.digest('hex'), bytes };
  }

  async readRaw(relative: string): Promise<Buffer> {
    return readFile(this.resolveInside(relative));
  }

  /** Bytes currently held by retained raw files and leftover work files. */
  async usage(): Promise<number> {
    this.assertSafeDirectories();
    let total = 0;
    for (const dir of [this.rawDir, this.workDir]) {
      let names: string[] = [];
      names = await readdir(dir);
      for (const name of names) {
        try { total += (await lstat(join(dir, name))).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    return total;
  }

  async freeBytes(): Promise<number> {
    this.assertSafeDirectories();
    try {
      const info = await statfs(this.root);
      return Number(info.bavail) * Number(info.bsize);
    } catch (error) {
      throw new OriginalFileError('storage_unavailable', 'Cannot determine available disk space (' + ((error as NodeJS.ErrnoException).code ?? 'I/O error') + ')');
    }
  }

  /**
   * Delete raw files no retained task references, oldest first, until the area is
   * under `limitBytes`. Calls must be refused by the caller while a task is active.
   */
  async enforceQuota(limitBytes: number, referenced: ReadonlySet<string>, canDelete: (sha: string) => boolean = sha => !referenced.has(sha)): Promise<MaintenanceResult> {
    return this.withRawLock(()=>this.enforceQuotaLocked(limitBytes,referenced,canDelete));
  }
  private async enforceQuotaLocked(limitBytes:number,referenced:ReadonlySet<string>,canDelete:(sha:string)=>boolean):Promise<MaintenanceResult>{
    const removed: string[] = [];
    try {
    let names: string[] = [];
    names = await readdir(this.rawDir);
    const entries: Array<{ name: string; size: number; at: number }> = [];
    for (const name of names) {
      const path = join(this.rawDir, name);
      const sha = name.replace(/\.[a-z]+$/u, '');
      if (referenced.has(sha)) continue;
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw Object.assign(new Error('Unsafe raw file'), { code: 'UNSAFE_FILE' });
        entries.push({ name, size: info.size, at: info.mtimeMs });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    entries.sort((left, right) => left.at - right.at);
    let total = await this.usage();
    for (const entry of entries) {
      if (total <= limitBytes) break;
      // Recheck live references after asynchronous enumeration, directly before unlink.
      if (!canDelete(entry.name.replace(/\.[a-z]+$/u, ''))) continue;
      this.assertSafeDirectories();rmSync(join(this.rawDir,entry.name));
      total -= entry.size;
      removed.push(entry.name);
    }
    const result: MaintenanceResult = { status: total > limitBytes ? 'over_quota_referenced' : 'success', removed, usageBytes: await this.usage(), limitBytes };
    this.assertSafeDirectories();writeFileSync(join(this.root, 'quota.json'), JSON.stringify({ ...result, reason: total > limitBytes ? 'Referenced originals or work files prevent safe quota recovery' : null }), 'utf8');
    return result;
    } catch (error) { return { ...maintenanceFailure(error, removed), limitBytes }; }
  }

  /** Only incomplete, expired attempts are removable; active task prefixes remain protected. */
  async clearExpiredParts(now = Date.now(), activeTaskIds: readonly string[] = []): Promise<string[]> {
    this.assertSafeDirectories();
    const removed: string[] = [];
    for (const name of await readdir(this.workDir)) {
      if (!name.endsWith('.part') || activeTaskIds.some(id => name.startsWith(id + '-'))) continue;
      const path = join(this.workDir, name);
      const info = await stat(path);
      if (!info.isFile() || now - info.mtimeMs < 24 * 60 * 60 * 1000) continue;
      this.assertSafeDirectories();if(lstatSync(path).isSymbolicLink())throw new OriginalFileError('original_integrity','Unsafe expired part');rmSync(path); removed.push(name);
    }
    return removed;
  }

  /** Best-effort removal of a prepared file that is no longer needed. */
  async clearPrepared(taskId: string): Promise<void> {
    await this.removeIfPresent(this.preparedPath(taskId));
  }

  /** Create an empty work file for a streaming download. */
  async beginDownload(taskId: string): Promise<{ path: string; stream: ReturnType<typeof createWriteStream> }> {
    this.assertSafeDirectories();
    const path = this.partialPath(`${taskId}-${randomUUID()}`);
    this.assertSafeDirectories();const fd=openSync(path,'wx',0o600);const stream = createWriteStream(path, {fd,autoClose:true});
    return { path, stream };
  }
}
