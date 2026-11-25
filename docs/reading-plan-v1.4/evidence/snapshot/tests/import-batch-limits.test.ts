import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { ImportBatches, readZipPlan } from '../src/import-batches.ts';
import { BATCH_ITEM_LIMIT } from '../src/import-batch.ts';

/**
 * v1.4 batch completeness: nothing is dropped silently. An archive that cannot
 * fit one batch is refused whole and kept, and every refusal is reported with
 * exact counts (plus names while they fit).
 */
let dir: string, lib: Library, batches: ImportBatches, time: number;
const now = () => time;
const KiB = 1024;

/** Small but book-shaped: a real title line plus body, so titles stay distinct. */
const body = (seed: string): Buffer => Buffer.from(`# ${seed}\n` + `${seed} text. `.repeat(200));
const many = (count: number): [string, Buffer][] => Array.from({ length: count }, (_, index) => [`书${String(index + 1).padStart(3, '0')}.txt`, body(`s${index}`)]);

const SMALL = { batchBytes: 64 * KiB, fileBytes: 32 * KiB, zipBytes: 512 * KiB, workspaceBytes: 1024 * KiB };

async function open(budget: typeof SMALL = SMALL, diskFree?: (path: string) => number | null) {
  if (lib) { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } }
  lib = new Library({ dataDir: dir, now });
  lib.open();
  batches = new ImportBatches(lib, join(dir, 'transfers'), { now, budget, ...(diskFree ? { diskFree } : {}) });
}

beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'bookfish-batch-limits-')); time = Date.parse('2026-10-13T08:00:00Z'); await open(); });
afterEach(async () => { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

const zipPath = (id: string) => join(dir, 'transfers', 'batches', id, 'source.zip');

async function makeZip(entries: [string, Buffer][], file: string): Promise<Buffer> {
  const yazl = await import('yazl');
  const zip = new yazl.ZipFile();
  for (const [name, entry] of entries) zip.addBuffer(entry, name);
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(file);
    out.on('close', () => resolve()).on('error', reject);
    zip.outputStream.pipe(out);
  });
  return readFileSync(file);
}

function upload(batchId: string, bytes: Buffer): void {
  for (let offset = 0; offset < bytes.length; offset += 8 * KiB) {
    batches.zipChunk(batchId, offset, bytes.subarray(offset, offset + 8 * KiB).toString('base64'));
  }
}

async function importZip(zip: Buffer): Promise<string> {
  const batch = batches.create({ source: 'zip' });
  batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length });
  upload(batch.id, zip);
  return batch.id;
}

describe('an archive that cannot fit one batch is refused whole, never trimmed', () => {
  it('reads the declared expansion from the central directory', async () => {
    const file = join(dir, 'plan.zip');
    const zip = await makeZip(many(3), file);
    const plan = readZipPlan(file);
    expect(plan).not.toBeNull();
    expect(plan!.entries).toBe(3);
    expect(plan!.supported).toBe(3);
    // Uncompressed total, not the (much smaller) archive size.
    expect(plan!.totalUncompressed).toBeGreaterThan(zip.length);
    expect(plan!.totalUncompressed).toBe(many(3).reduce((total, [, entry]) => total + entry.length, 0));
  });

  it(`refuses ${BATCH_ITEM_LIMIT + 20} books instead of importing the first ${BATCH_ITEM_LIMIT}`, async () => {
    const file = join(dir, 'many.zip');
    const zip = await makeZip(many(BATCH_ITEM_LIMIT + 20), file);
    const batchId = await importZip(zip);

    await expect(batches.zipFinish(batchId)).rejects.toThrow('超过单批');
    const after = lib.importBatches()[0];
    expect(after.zip?.state).toBe('ready');
    expect(after.zip?.failure).toBe('over_limit');
    // The archive is kept: it is the only copy of the 120 books.
    expect(existsSync(zipPath(batchId))).toBe(true);
    expect(statSync(zipPath(batchId)).size).toBe(zip.length);
    // No silent partial import.
    expect(after.items).toHaveLength(0);
    // The report says exactly how many did not fit, and names them.
    const report = batches.status(batchId).report;
    expect(report.overflow).toBe(20);
    expect(report.incomplete).toBe(true);
    expect(report.rejectedNames.overflow.length).toBeGreaterThan(0);
    expect(report.rejectedNames.overflow[0]).toMatch(/\.txt$/u);
  });

  it(`accepts exactly ${BATCH_ITEM_LIMIT} books`, async () => {
    // A 100-book archive needs room for ~200 KiB of expansion; this is the count
    // limit under test, not the byte budget.
    await open({ ...SMALL, batchBytes: 512 * KiB, workspaceBytes: 1024 * KiB });
    const file = join(dir, 'limit.zip');
    const zip = await makeZip(many(BATCH_ITEM_LIMIT), file);
    const batchId = await importZip(zip);
    await expect(batches.zipFinish(batchId)).resolves.toBeTruthy();
    const after = lib.importBatches()[0];
    expect(after.items).toHaveLength(BATCH_ITEM_LIMIT);
    expect(after.zip?.state).toBe('extracted');
    expect(batches.status(batchId).report.overflow).toBe(0);
  });

  it('refuses an archive whose expansion exceeds the batch budget and keeps it', async () => {
    const file = join(dir, 'big.zip');
    // Forty books stay well inside the 100-book limit but expand past the 64 KiB
    // byte ceiling, so this is the byte path, not the count path.
    const zip = await makeZip(many(40), file);
    const batchId = await importZip(zip);
    await expect(batches.zipFinish(batchId)).rejects.toThrow('超过本批可用');
    const after = lib.importBatches()[0];
    expect(after.zip?.failure).toBe('over_limit');
    expect(after.items).toHaveLength(0);
    expect(existsSync(zipPath(batchId))).toBe(true);
  });

  it('reports count overflow for a folder of 101 files without pretending success', async () => {
    const batch = batches.create({ source: 'folder' });
    // Small declared sizes keep the byte budget out of the way: the only limit
    // that can bite here is the 100-item one.
    const inputs = many(BATCH_ITEM_LIMIT + 1).map(([name]) => ({ name, size: 10 }));
    const result = batches.addItems(batch.id, inputs);
    expect(result.added).toHaveLength(BATCH_ITEM_LIMIT);
    expect(result.overflow).toBe(1);
    const report = batches.status(batch.id).report;
    expect(report.accepted).toBe(BATCH_ITEM_LIMIT);
    expect(report.overflow).toBe(1);
    expect(report.incomplete).toBe(true);
  });
});

describe('every refusal is in the report, not just the accepted rows', () => {
  it('counts duplicates, unsupported, over-sized and over-budget files', () => {
    const batch = batches.create({ source: 'files' });
    const book = (name: string, size: number) => ({ name, size });
    const result = batches.addItems(batch.id, [
      book('甲.txt', 100),
      book('甲.txt', 100),                       // same name in one request
      book('封面.jpg', 100),                      // unsupported
      book('巨书.txt', 40 * KiB),                 // over the 32 KiB per-book ceiling
      book('大书甲.txt', 40 * KiB),               // over budget before the per-book check
    ]);
    expect(result.added).toHaveLength(1);
    const report = batches.status(batch.id).report;
    expect(report.duplicate).toBe(1);
    expect(report.unsupported).toBe(1);
    // Both over-sized files are refused and counted; which bucket wins is the
    // budget's business, but neither may vanish.
    expect(report.tooLarge + report.overBudget).toBe(2);
    expect(report.unsupported + report.duplicate + report.tooLarge + report.overBudget).toBe(4);
    expect(report.incomplete).toBe(true);
    expect(report.rejectedNames.unsupported).toContain('封面.jpg');
    // Totals survive a reload: the report is persisted with the batch.
    expect(lib.importBatches()[0].rejected?.unsupported.count).toBe(1);
  });

  it('is complete when nothing was refused', () => {
    const batch = batches.create({ source: 'files' });
    batches.addItems(batch.id, [{ name: '甲.txt', size: 100 }]);
    const report = batches.status(batch.id).report;
    expect(report.incomplete).toBe(false);
    expect(report.accepted).toBe(1);
    expect(report.duplicate + report.unsupported + report.tooLarge + report.overBudget + report.overflow).toBe(0);
  });
});

describe('the disk precheck uses the real estimate, not the worst case', () => {
  it('accepts a small archive when free space covers its expansion but not the ceiling', async () => {
    const file = join(dir, 'small.zip');
    const zip = await makeZip(many(2), file);
    const plan = readZipPlan(file)!;
    // Free space is above what the archive expands to, far below the 64 KiB
    // ceiling: the old rule refused this, which made small ZIPs demand a gigabyte.
    await open(SMALL, () => plan.totalUncompressed + 4096);
    const batchId = await importZip(zip);
    await expect(batches.zipFinish(batchId)).resolves.toBeTruthy();
    expect(lib.importBatches()[0].zip?.state).toBe('extracted');
  });
});
