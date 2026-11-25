import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { DEFAULT_BATCH_BUDGET, ImportBatches } from '../src/import-batches.ts';
import { BATCH_CONCURRENCY, BATCH_ITEM_LIMIT, BATCH_STAGING_BYTES, MAX_BATCH_FILE_BYTES, ZIP_MAX_BYTES, batchStagingName } from '../src/import-batch.ts';

const MiB = 1024 * 1024;
let dir: string, lib: Library, batches: ImportBatches, time: number;
const now = () => time;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-batch-budget-'));
  time = Date.parse('2026-10-06T08:00:00Z');
  lib = new Library({ dataDir: dir, now });
  lib.open();
  batches = new ImportBatches(lib, join(dir, 'transfers'), { now });
});
afterEach(async () => {
  await batches.shutdown();
  try { lib.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

const names = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `n${index}.txt`, size: 1024 }));

describe('the declared limits are the ones that ship', () => {
  it('pins every ceiling the task book names', () => {
    expect(MAX_BATCH_FILE_BYTES).toBe(100 * MiB);
    expect(BATCH_ITEM_LIMIT).toBe(100);
    expect(BATCH_STAGING_BYTES).toBe(1024 * MiB);
    expect(BATCH_CONCURRENCY).toBe(2);
    expect(ZIP_MAX_BYTES).toBe(512 * MiB);
    expect(DEFAULT_BATCH_BUDGET).toEqual({
      batchBytes: 1024 * MiB, fileBytes: 100 * MiB, zipBytes: 512 * MiB,
      // v1.2: the real workspace is the archive plus the staged books. Entries
      // are renamed into place, so there is no third copy and no extra ceiling.
      workspaceBytes: 1536 * MiB,
    });
    expect(DEFAULT_BATCH_BUDGET.workspaceBytes)
      .toBe(DEFAULT_BATCH_BUDGET.zipBytes + DEFAULT_BATCH_BUDGET.batchBytes);
  });
});

describe('a batch can never stage more than its budget', () => {
  it('accepts 100 files and reports the 101st as overflow without staging it', () => {
    const batch = batches.create({ source: 'files' });
    const result = batches.addItems(batch.id, names(101));
    expect(result.added).toHaveLength(100);
    expect(result.overflow).toBe(1);
    expect(lib.importBatches()[0].items).toHaveLength(100);
    // Nothing was written for the rejected file.
    const staged = readdirSync(join(dir, 'transfers', 'batches', batch.id)).filter((file) => file.endsWith('.src'));
    expect(staged).toHaveLength(0);
  });

  it('refuses a single file above 100 MiB before it is staged', () => {
    const batch = batches.create({ source: 'files' });
    const result = batches.addItems(batch.id, [{ name: 'huge.txt', size: 100 * MiB + 1 }]);
    expect(result.added).toEqual([]);
    expect(result.tooLarge).toEqual(['huge.txt']);
    expect(lib.importBatches()[0].items).toEqual([]);
  });

  it('accepts exactly 100 MiB and exactly 1 GiB in total, refusing one byte more', () => {
    // A per-file ceiling and a batch ceiling are different limits.
    const single = batches.create({ source: 'files' });
    const atCeiling = batches.addItems(single.id, [{ name: 'a.txt', size: MAX_BATCH_FILE_BYTES }]);
    expect(atCeiling.added.map((item) => item.name)).toEqual(['a.txt']);

    // Exactly 1 GiB built from files that each respect the 100 MiB ceiling.
    const exact = batches.create({ source: 'files' });
    const ten = Array.from({ length: 10 }, (_, index) => ({ name: `p${index}.txt`, size: MAX_BATCH_FILE_BYTES }));
    const boundary = batches.addItems(exact.id, [...ten, { name: 'tail.txt', size: BATCH_STAGING_BYTES - 10 * MAX_BATCH_FILE_BYTES }]);
    expect(boundary.added).toHaveLength(11);
    expect(BATCH_STAGING_BYTES - 10 * MAX_BATCH_FILE_BYTES).toBe(24 * MiB);
    const oneMore = batches.addItems(exact.id, [{ name: 'z.txt', size: 1 }]);
    expect(oneMore.added).toEqual([]);
    expect(oneMore.overBudget).toEqual(['z.txt']);
  });

  it('re-checks the budget when a chunk arrives, not only in the panel', () => {
    const small = new ImportBatches(lib, join(dir, 'transfers'), { now, budget: { batchBytes: 4096 } });
    const batch = small.create({ source: 'files' });
    small.addItems(batch.id, [{ name: 'a.txt', size: 2048 }]);
    // Tamper with the persisted batch the way a corrupted snapshot would.
    lib.updateImportBatch(batch.id, (draft) => { draft.items[0].size = 1_000_000; });
    expect(() => small.stage(batch.id, lib.importBatches()[0].items[0].id, 0, Buffer.from('hello').toString('base64')))
      .toThrow('disk budget');
    void small.shutdown();
  });

  it('refuses a chunked upload that would exceed the per-file ceiling', () => {
    const batch = batches.create({ source: 'files' });
    batches.addItems(batch.id, [{ name: 'a.txt', size: 64 }]);
    const item = lib.importBatches()[0].items[0];
    lib.updateImportBatch(batch.id, (draft) => { draft.items[0].size = 100 * MiB + 1; });
    expect(() => batches.stage(batch.id, item.id, 0, Buffer.from('hello').toString('base64'))).toThrow('100 MiB');
  });

  it('rejects an archive that expands beyond the batch budget', async () => {
    const yazl = await import('yazl');
    const small = new ImportBatches(lib, join(dir, 'transfers'), { now, budget: { batchBytes: 4096, fileBytes: 3000 } });
    const zipPath = join(dir, 'big.zip');
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.alloc(2048, 97), 'a.txt');
    zip.addBuffer(Buffer.alloc(2048, 98), 'b.txt');
    zip.addBuffer(Buffer.alloc(2048, 99), 'c.txt');
    zip.end();
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(zipPath);
      out.on('close', () => resolve()).on('error', reject);
      zip.outputStream.pipe(out);
    });
    const batch = small.create({ source: 'zip' });
    small.zipBegin(batch.id, { name: 'big.zip', size: statSync(zipPath).size });
    const bytes = readFileSync(zipPath);
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      small.zipChunk(batch.id, offset, bytes.subarray(offset, offset + 64 * 1024).toString('base64'));
    }
    await expect(small.zipFinish(batch.id)).rejects.toThrow(/限制|GiB|过大|数量/u);
    await small.shutdown();
  });

  it('rejects an archive entry above the per-book ceiling', async () => {
    const yazl = await import('yazl');
    const small = new ImportBatches(lib, join(dir, 'transfers'), { now, budget: { batchBytes: 1024 * 1024, fileBytes: 1024 } });
    const zipPath = join(dir, 'entry.zip');
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.alloc(4096, 97), 'big.txt');
    zip.end();
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(zipPath);
      out.on('close', () => resolve()).on('error', reject);
      zip.outputStream.pipe(out);
    });
    const batch = small.create({ source: 'zip' });
    small.zipBegin(batch.id, { name: 'entry.zip', size: statSync(zipPath).size });
    const bytes = readFileSync(zipPath);
    small.zipChunk(batch.id, 0, bytes.toString('base64'));
    await expect(small.zipFinish(batch.id)).rejects.toThrow();
    await small.shutdown();
  });

  it('refuses a ZIP upload body above 512 MiB', () => {
    const batch = batches.create({ source: 'zip' });
    expect(() => batches.zipBegin(batch.id, { name: 'huge.zip', size: ZIP_MAX_BYTES + 1 })).toThrow('512 MiB');
  });

  it('leaves other batches and already imported books untouched when one batch fails', async () => {
    const goodBytes = Buffer.from('# good\n\n' + 'the sea is wide. '.repeat(8));
    const good = batches.create({ source: 'files' });
    batches.addItems(good.id, [{ name: 'good.txt', size: goodBytes.length }]);
    const goodItem = lib.importBatches()[0].items[0];
    batches.stage(good.id, goodItem.id, 0, goodBytes.toString('base64'));

    const badBytes = Buffer.from('\u0000\u0001binary'.padEnd(64, 'x'));
    const bad = batches.create({ source: 'files' });
    batches.addItems(bad.id, [{ name: 'bad.txt', size: badBytes.length }]);
    const badItem = lib.importBatches().at(-1)!.items[0];
    batches.stage(bad.id, badItem.id, 0, badBytes.toString('base64'));

    batches.start(good.id);
    batches.start(bad.id);
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const rows = lib.importBatches();
        const done = rows.every((row) => row.status === 'completed' || row.status === 'cancelled');
        if (done) { clearInterval(poll); resolve(); return; }
        if (Date.now() - started > 30_000) { clearInterval(poll); reject(new Error('timeout')); }
      }, 60);
    });
    expect(lib.importBatches().find((row) => row.id === good.id)!.items[0].status).toBe('completed');
    expect(lib.importBatches().find((row) => row.id === bad.id)!.items[0].status).toBe('failed');
    expect(lib.list()).toHaveLength(1);

    // Forgetting the failed batch removes only its own staging directory.
    lib.forgetImportBatch(bad.id);
    batches.cleanStale();
    expect(existsSync(join(dir, 'transfers', 'batches', bad.id))).toBe(false);
    expect(existsSync(join(dir, 'transfers', 'batches', good.id))).toBe(true);
    expect(lib.list()).toHaveLength(1);
  });

  it('never deletes a directory it did not create', () => {
    const batch = batches.create({ source: 'files' });
    const foreign = join(dir, 'transfers', 'batches', 'someone-elses-data');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'keep.txt'), 'keep');
    batches.cleanStale();
    expect(readFileSync(join(foreign, 'keep.txt'), 'utf8')).toBe('keep');
    void batch;
  });

  it('keeps a batch item that is legitimate alongside one that is refused', () => {
    const batch = batches.create({ source: 'files' });
    const result = batches.addItems(batch.id, [
      { name: 'ok.txt', size: 1024 },
      { name: 'too-big.txt', size: MAX_BATCH_FILE_BYTES + 1 },
      { name: 'other.txt', size: 1024 },
    ]);
    expect(result.added.map((item) => item.name)).toEqual(['ok.txt', 'other.txt']);
    expect(result.tooLarge).toEqual(['too-big.txt']);
    const staged = join(dir, 'transfers', 'batches', batch.id);
    expect(readdirSync(staged).filter((file) => file === batchStagingName(result.added[0].id))).toEqual([]);
  });
});
