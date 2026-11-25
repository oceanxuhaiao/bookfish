import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PathLike } from 'node:fs';
import { Library } from '../src/library.ts';
import { ImportBatches } from '../src/import-batches.ts';

/**
 * Fault injection for the rename that moves an extracted entry into its staging
 * slot. The mock only intercepts `renameSync` calls whose destination ends with
 * `.src`; everything else (including the Library's own atomic writes) passes
 * through untouched. Extraction itself runs in a worker thread, which this mock
 * cannot and must not touch.
 *
 * `failAt` = 1-based ordinal of the `.src` rename to fail; `failAll` fails them
 * all. `srcSeen` counts the renames that were attempted.
 */
const control = vi.hoisted(() => ({ failAt: null as number | null, failAll: false, srcSeen: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: ((from: PathLike, to: PathLike) => {
      if (String(to).endsWith('.src')) {
        control.srcSeen += 1;
        if (control.failAll || control.failAt === control.srcSeen) {
          throw Object.assign(new Error('EFAULT: simulated cross-device rename refusal'), { code: 'EFAULT' });
        }
      }
      return actual.renameSync(from, to);
    }) satisfies typeof import('node:fs').renameSync,
  };
});

let dir: string, lib: Library, batches: ImportBatches, time: number;
const now = () => time;
const KiB = 1024;

const BUDGET = { batchBytes: 64 * KiB, fileBytes: 32 * KiB, zipBytes: 16 * KiB, workspaceBytes: 80 * KiB };

async function open() {
  if (lib) { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } }
  lib = new Library({ dataDir: dir, now });
  lib.open();
  batches = new ImportBatches(lib, join(dir, 'transfers'), { now, budget: BUDGET });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-rename-'));
  time = Date.parse('2026-10-13T08:00:00Z');
  control.failAt = null; control.failAll = false; control.srcSeen = 0;
  await open();
});
afterEach(async () => { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

const batchDir = (id: string) => join(dir, 'transfers', 'batches', id);

/** Independent recursive byte count of the batch directory. */
function dirBytes(batchId: string): number {
  const root = batchDir(batchId);
  if (!existsSync(root)) return 0;
  const walk = (at: string): number => {
    let total = 0;
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      const stat = statSync(full);
      if (stat.isDirectory()) total += walk(full);
      else total += stat.size;
    }
    return total;
  };
  return walk(root);
}

async function makeZip(entries: [string, Buffer][], file: string): Promise<number> {
  const yazl = await import('yazl');
  const zip = new yazl.ZipFile();
  for (const [name, body] of entries) zip.addBuffer(body, name);
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(file);
    out.on('close', () => resolve()).on('error', reject);
    zip.outputStream.pipe(out);
  });
  return statSync(file).size;
}

const body = (seed: string): Buffer => Buffer.from(`# ${seed}\n` + `${seed} the tide is low. `.repeat(360));
const books = (): [string, Buffer][] => [body('甲'), body('乙'), body('丙')].map((bytes, index) => [`第${index + 1}本.txt`, bytes]);

async function uploadArchive(batchId: string, file: string) {
  const bytes = readFileSync(file);
  batches.zipBegin(batchId, { name: 'books.zip', size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += 8 * KiB) {
    batches.zipChunk(batchId, offset, bytes.subarray(offset, offset + 8 * KiB).toString('base64'));
  }
  return batches.zipFinish(batchId);
}

describe('a refused rename never falls back to an unbudgeted copy', () => {
  it('keeps the archive, refuses extraction with a clear reason, and recovers on retry', async () => {
    const file = join(dir, 'books.zip');
    const zipSize = await makeZip(books(), file);
    const treeSize = books().reduce((total, [, bytes]) => total + bytes.length, 0);
    control.failAll = true;
    const batch = batches.create({ source: 'zip' });
    await expect(uploadArchive(batch.id, file)).rejects.toThrow('文件系统或权限问题');
    // No copy fallback happened: no `.src` exists, the temporary tree is gone,
    // and the verified archive is kept for a retry.
    const after = lib.importBatches()[0];
    expect(readdirSync(batchDir(batch.id)).filter((name) => name.endsWith('.src'))).toHaveLength(0);
    expect(readdirSync(batchDir(batch.id)).some((name) => name.endsWith('.extract'))).toBe(false);
    expect(existsSync(join(batchDir(batch.id), 'source.zip'))).toBe(true);
    expect(after.zip?.state).toBe('ready');
    expect(after.items).toHaveLength(3);
    void zipSize; void treeSize;

    // The filesystem "recovers": the same batch retries without a re-upload.
    control.failAll = false;
    const result = await batches.zipFinish(batch.id);
    expect(result.added).toHaveLength(0); // the entries already exist; nothing is added twice
    const done = lib.importBatches()[0];
    expect(done.items).toHaveLength(3);
    expect(done.items.every((item) => item.staged)).toBe(true);
    expect(done.zip?.state).toBe('extracted');
    expect(existsSync(join(batchDir(batch.id), 'source.zip'))).toBe(false);
    expect(dirBytes(batch.id)).toBe(treeSize);
  });

  it('resume() keeps a transient failure at `ready` instead of demanding a re-upload', async () => {
    const file = join(dir, 'books.zip');
    await makeZip(books(), file);
    const batch = batches.create({ source: 'zip' });
    control.failAll = true;
    await expect(uploadArchive(batch.id, file)).rejects.toThrow('文件系统或权限问题');
    // The failure is recorded and classified, and the state is still `ready`:
    // a refused rename says nothing about the archive being lost.
    const failed = lib.importBatches()[0];
    expect(failed.zip?.state).toBe('ready');
    expect(failed.zip?.failure).toBe('transient');
    expect(failed.zip?.error).toContain('文件系统或权限问题');
    const zipBefore = statSync(join(batchDir(batch.id), 'source.zip')).size;

    // A restart while the filesystem is still broken: recovery tries again, fails
    // again, and must NOT downgrade the batch to `needs_reselect`.
    await batches.shutdown();
    lib.close();
    await open();
    // Capture the background flight so the test ends only after it settles: the
    // recovery chain is deliberately not awaited by resume().
    const spy = vi.spyOn(batches, 'importZip');
    const report = batches.resume();
    expect(report.archives).toBe(1);
    await new Promise<void>((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (spy.mock.calls.length > 0 || Date.now() - started > 10_000) { clearInterval(poll); resolve(); }
      }, 20);
    });
    await Promise.all(spy.mock.results.map((row) => Promise.resolve(row.value).catch(() => undefined)));
    const during = lib.importBatches()[0];
    expect(['ready', 'extracted']).toContain(during.zip?.state);
    if (during.zip?.state === 'ready') expect(during.zip?.failure).toBe('transient');
    // The verified archive is untouched by any of this.
    expect(statSync(join(batchDir(batch.id), 'source.zip')).size).toBe(zipBefore);
  });
});

describe('a partial extraction failure retries within the same budget', () => {
  it('moves one book, fails the second, restarts, and finishes without exceeding the ceiling', async () => {
    const file = join(dir, 'books.zip');
    const zipSize = await makeZip(books(), file);
    const treeSize = books().reduce((total, [, bytes]) => total + bytes.length, 0);
    const bookSize = treeSize / 3;
    // Book 1 moves into its slot; book 2's move is refused.
    control.failAt = 2;
    const batch = batches.create({ source: 'zip' });
    await expect(uploadArchive(batch.id, file)).rejects.toThrow('文件系统或权限问题');

    // Interruption state: archive + one staged book, tree cleaned up.
    const partial = lib.importBatches()[0];
    expect(partial.items.filter((item) => item.staged)).toHaveLength(1);
    expect(readdirSync(batchDir(batch.id)).some((name) => name.endsWith('.extract'))).toBe(false);
    expect(existsSync(join(batchDir(batch.id), 'source.zip'))).toBe(true);
    // The retry budget must fit: zip + staged book + a fresh full tree.
    expect(zipSize + bookSize + treeSize).toBeLessThanOrEqual(BUDGET.workspaceBytes);
    expect(partial.zip?.peakBytes).toBeLessThanOrEqual(BUDGET.workspaceBytes);

    // Restart: a new process, the fault gone, the archive still trusted.
    await batches.shutdown();
    lib.close();
    control.failAt = null;
    await open();
    const report = batches.resume();
    expect(report.archives).toBeGreaterThanOrEqual(1);
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const state = lib.importBatches()[0].zip?.state;
        if (state === 'extracted' || state === 'needs_reselect') { clearInterval(poll); resolve(); return; }
        if (Date.now() - started > 20_000) { clearInterval(poll); reject(new Error('timeout')); }
      }, 50);
    });
    const done = lib.importBatches()[0];
    expect(done.zip?.state).toBe('extracted');
    // No duplicate entries from the retry, every book staged exactly once.
    expect(done.items).toHaveLength(3);
    const names = done.items.map((item) => item.name);
    expect(new Set(names).size).toBe(3);
    expect(done.items.every((item) => item.staged)).toBe(true);
    expect(done.items.every((item) => !item.duplicate)).toBe(true);
    // The measured peak, including the retry pass, stayed inside the workspace.
    expect(done.zip?.peakBytes).toBeLessThanOrEqual(BUDGET.workspaceBytes);
    expect(dirBytes(batch.id)).toBe(treeSize);
    expect(existsSync(join(batchDir(batch.id), 'source.zip'))).toBe(false);
  });
});

describe('disk space is checked before extraction writes anything', () => {
  /** Reopen with an injected disk-free probe; the archive was already uploaded. */
  const reopenWithDisk = async (diskFree: (path: string) => number | null): Promise<string> => {
    const file = join(dir, 'books.zip');
    await makeZip(books(), file);
    const batchId = batches.create({ source: 'zip' }).id;
    // Upload under the normal budget, then stop before extraction.
    const bytes = readFileSync(file);
    batches.zipBegin(batchId, { name: 'books.zip', size: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += 8 * KiB) {
      batches.zipChunk(batchId, offset, bytes.subarray(offset, offset + 8 * KiB).toString('base64'));
    }
    await batches.shutdown();
    lib.close();
    lib = new Library({ dataDir: dir, now });
    lib.open();
    batches = new ImportBatches(lib, join(dir, 'transfers'), { now, budget: BUDGET, diskFree });
    return batchId;
  };

  it('refuses up front when the filesystem cannot hold the estimate', async () => {
    const batchId = await reopenWithDisk(() => 1024);
    // v1.4 compares against the archive's own declared expansion (not the 1 GiB
    // worst case), so the refusal states the real numbers.
    await expect(batches.zipFinish(batchId)).rejects.toThrow('磁盘剩余');
    // Refused BEFORE writing: no temporary tree, the verified archive kept.
    expect(readdirSync(batchDir(batchId)).some((name) => name.endsWith('.extract'))).toBe(false);
    expect(existsSync(join(batchDir(batchId), 'source.zip'))).toBe(true);
    expect(lib.importBatches()[0].zip?.state).toBe('ready');
    // The failure is recorded, and it is a disk failure — not a lost archive.
    expect(lib.importBatches()[0].zip?.failure).toBe('disk');
  });

  it('proceeds when the disk has room for the estimate', async () => {
    const batchId = await reopenWithDisk(() => 10 * KiB * KiB);
    await expect(batches.zipFinish(batchId)).resolves.toBeTruthy();
    expect(lib.importBatches()[0].zip?.state).toBe('extracted');
  });

  it('refuses when the free space cannot be measured instead of assuming it is safe', async () => {
    const batchId = await reopenWithDisk(() => null);
    await expect(batches.zipFinish(batchId)).rejects.toThrow('无法测量磁盘剩余空间');
    // Nothing was written and the archive is still there for a later attempt.
    expect(readdirSync(batchDir(batchId)).some((name) => name.endsWith('.extract'))).toBe(false);
    expect(existsSync(join(batchDir(batchId), 'source.zip'))).toBe(true);
    expect(lib.importBatches()[0].zip?.state).toBe('ready');
    expect(lib.importBatches()[0].zip?.failure).toBe('disk');
  });
});
