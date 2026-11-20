/**
 * Dedicated staging area for acquired files: <dataDir>/bookfish/txt-acquisition.
 * Raw downloaded bytes never go into the book body directory, and a retained
 * file stays available after a failed import so the work can be retried.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import type { FileFormat } from './types.ts';

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

  /** Guard every derived path against traversal outside the acquisition root. */
  resolveInside(relative: string): string {
    const absolute = resolve(this.root, relative);
    if (absolute !== this.root && !absolute.startsWith(this.root + sep)) throw new Error('Staging path escapes the acquisition directory');
    return absolute;
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
    const relative = join('raw', `${sha256}.${format}`);
    await rename(temporary, this.resolveInside(relative));
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
      try { names = await readdir(dir); } catch { continue; }
      for (const name of names) {
        try { total += (await stat(join(dir, name))).size; } catch { /* raced with cleanup */ }
      }
    }
    return total;
  }

  async freeBytes(): Promise<number> {
    try {
      const info = await statfs(this.root);
      return Number(info.bavail) * Number(info.bsize);
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  /**
   * Delete raw files no retained task references, oldest first, until the area is
   * under `limitBytes`. Calls must be refused by the caller while a task is active.
   */
  async enforceQuota(limitBytes: number, referenced: ReadonlySet<string>): Promise<string[]> {
    const removed: string[] = [];
    let names: string[] = [];
    try { names = await readdir(this.rawDir); } catch { return removed; }
    const entries: Array<{ name: string; size: number; at: number }> = [];
    for (const name of names) {
      const path = join(this.rawDir, name);
      const sha = name.replace(/\.[a-z]+$/u, '');
      if (referenced.has(sha)) continue;
      try {
        const info = await stat(path);
        entries.push({ name, size: info.size, at: info.mtimeMs });
      } catch { /* raced */ }
    }
    entries.sort((left, right) => left.at - right.at);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= limitBytes) break;
      await this.removeIfPresent(join(this.rawDir, entry.name));
      total -= entry.size;
      removed.push(entry.name);
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
    const path = this.partialPath(taskId);
    await rm(path, { force: true });
    return { path, stream: createWriteStream(path) };
  }
}
