/**
 * Dedicated staging area for acquired files: <dataDir>/bookfish/txt-acquisition.
 * Raw downloaded bytes never go into the book body directory, and a retained
 * file stays available after a failed import so the work can be retried.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile, lstat, realpath, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
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

export class AcquisitionStaging {
  readonly rawDir: string;
  readonly workDir: string;

  constructor(readonly root: string) {
    this.rawDir = join(root, 'raw');
    this.workDir = join(root, 'work');
  }

  async init(): Promise<void> {
    await mkdir(this.rawDir, { recursive: true });
    await mkdir(this.workDir, { recursive: true });
  }

  /** Mount owns the library writer lock and no acquisition is running yet. */
  async clearAbandonedPrepared(): Promise<void> {
    for (const name of await readdir(this.workDir)) {
      if (/^[a-f0-9-]{36}\.verified\.txt(?:\.[a-f0-9-]{36}\.prepared\.txt)?$/u.test(name) || /^[a-f0-9-]{36}\.prepared\.txt$/u.test(name)) await rm(join(this.workDir, name));
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
        const output = await open(snapshot, 'wx');
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
      if (snapshot) await rm(snapshot, { force: true }).catch(() => undefined);
      if (error instanceof OriginalFileError) throw error;
      throw new OriginalFileError('storage_unavailable', 'Cannot read or verify the retained original (' + ((error as NodeJS.ErrnoException).code ?? 'I/O error') + ')');
    }
  }

  partialPath(taskId: string): string {
    return this.resolveInside(join('work', `${taskId}.part`));
  }

  preparedPath(taskId: string): string {
    return this.resolveInside(join('work', `${taskId}.prepared.txt`));
  }

  async writePrepared(taskId: string, text: string): Promise<string> {
    const target = this.preparedPath(taskId);
    await mkdir(this.workDir, { recursive: true });
    await writeFile(target, text, 'utf8');
    return target;
  }

  async removeIfPresent(path: string): Promise<void> {
    try {
      await rm(path, { force: true });
    } catch { /* best effort */ }
  }

  /** Move a completed download into raw/<sha256>.<format>. */
  async commitRaw(temporary: string, sha256: string, format: FileFormat): Promise<string> {
    await mkdir(this.rawDir, { recursive: true });
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('Invalid raw file digest');
    if (!resolve(temporary).startsWith(resolve(this.workDir) + sep) || !(await lstat(temporary)).isFile() || (await lstat(temporary)).isSymbolicLink() || resolve(await realpath(temporary)) !== resolve(temporary)) throw new OriginalFileError('original_integrity', 'Untrusted download work file');
    if ((await this.hashFile(temporary)).sha256 !== sha256) throw new Error('Staged file checksum mismatch');
    const relative = join('raw', sha256 + '.' + format);
    const target = this.resolveInside(relative);
    try { await link(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if ((await lstat(target)).isSymbolicLink() || !(await lstat(target)).isFile()) throw new OriginalFileError('original_integrity', 'Existing original is not a regular file');
      if ((await this.hashFile(target)).sha256 !== sha256) throw new Error('Existing original file checksum mismatch');
    }
    await rm(temporary, { force: true });
    return relative;
  }

  async hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
    const hash = createHash('sha256');
    let bytes = 0;
    await new Promise<void>((done, fail) => {
      const stream = createReadStream(path);
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
      await rm(join(this.rawDir, entry.name));
      total -= entry.size;
      removed.push(entry.name);
    }
    const result: MaintenanceResult = { status: total > limitBytes ? 'over_quota_referenced' : 'success', removed, usageBytes: await this.usage(), limitBytes };
    await writeFile(join(this.root, 'quota.json'), JSON.stringify({ ...result, reason: total > limitBytes ? 'Referenced originals or work files prevent safe quota recovery' : null }), 'utf8');
    return result;
    } catch (error) { return { ...maintenanceFailure(error, removed), limitBytes }; }
  }

  /** Only incomplete, expired attempts are removable; active task prefixes remain protected. */
  async clearExpiredParts(now = Date.now(), activeTaskIds: readonly string[] = []): Promise<string[]> {
    const removed: string[] = [];
    for (const name of await readdir(this.workDir)) {
      if (!name.endsWith('.part') || activeTaskIds.some(id => name.startsWith(id + '-'))) continue;
      const path = join(this.workDir, name);
      const info = await stat(path);
      if (!info.isFile() || now - info.mtimeMs < 24 * 60 * 60 * 1000) continue;
      await rm(path); removed.push(name);
    }
    return removed;
  }

  /** Best-effort removal of a prepared file that is no longer needed. */
  async clearPrepared(taskId: string): Promise<void> {
    await this.removeIfPresent(this.preparedPath(taskId));
  }

  /** Create an empty work file for a streaming download. */
  async beginDownload(taskId: string): Promise<{ path: string; stream: ReturnType<typeof createWriteStream> }> {
    await mkdir(this.workDir, { recursive: true });
    const path = this.partialPath(`${taskId}-${randomUUID()}`);
    const stream = createWriteStream(path, { flags: 'wx' });
    await new Promise<void>((ok, no) => { stream.once('open', () => ok()); stream.once('error', no); });
    return { path, stream };
  }
}
