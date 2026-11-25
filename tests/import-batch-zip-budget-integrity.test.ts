import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { ImportBatches } from '../src/import-batches.ts';
import { BATCH_ITEM_LIMIT, BATCH_SCHEMA, validateBatches } from '../src/import-batch.ts';

/**
 * v1.5 resource + persistence guarantees.
 *
 * The second (real) content check must not become a new hole: the worker keeps
 * its ceilings, an unknown index still gets a bounded extraction, and the
 * refusal record survives a reload with every "unknown" honestly null.
 */
let dir: string, lib: Library, batches: ImportBatches, time: number;
const now = () => time;
const KiB = 1024;

const BUDGET = { batchBytes: 256 * KiB, fileBytes: 64 * KiB, zipBytes: 768 * KiB, workspaceBytes: 1024 * KiB };

async function open(budget: Partial<typeof BUDGET> = BUDGET) {
  if (lib) { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } }
  lib = new Library({ dataDir: dir, now });
  lib.open();
  batches = new ImportBatches(lib, join(dir, 'transfers'), { now, budget });
}

beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'bookfish-zip-budget2-')); time = Date.parse('2026-10-13T08:00:00Z'); await open(); });
afterEach(async () => { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

const batchDir = (id: string) => join(dir, 'transfers', 'batches', id);

async function writeZip64(count: number, file: string, bytesPer = 60): Promise<Buffer> {
  const yazl = await import('yazl');
  const base = file + '.base';
  const zip = new yazl.ZipFile();
  for (let index = 0; index < count; index += 1) {
    zip.addBuffer(Buffer.from(`# s${index}\n` + `t${index} `.repeat(bytesPer)), `书${String(index + 1).padStart(3, '0')}.txt`);
  }
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(base);
    out.on('close', () => resolve()).on('error', reject);
    zip.outputStream.pipe(out);
  });
  const buffer = readFileSync(base);
  const eocdAt = buffer.length - 22;
  const entries = buffer.readUInt16LE(eocdAt + 10);
  const cdSize = buffer.readUInt32LE(eocdAt + 12);
  const cdOffset = buffer.readUInt32LE(eocdAt + 16);
  const record = Buffer.alloc(76);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(entries), 24); record.writeBigUInt64LE(BigInt(entries), 32);
  record.writeBigUInt64LE(BigInt(cdSize), 40); record.writeBigUInt64LE(BigInt(cdOffset), 48);
  record.writeUInt32LE(0x07064b50, 56);
  record.writeBigUInt64LE(BigInt(cdOffset + cdSize), 64); record.writeUInt32LE(1, 72);
  const tail = Buffer.from(buffer.subarray(eocdAt));
  tail.writeUInt16LE(0xffff, 10); tail.writeUInt32LE(0xffffffff, 12); tail.writeUInt32LE(0xffffffff, 16);
  const patched = Buffer.concat([buffer.subarray(0, eocdAt), record, tail]);
  writeFileSync(file, patched);
  return patched;
}

async function startArchive(bytes: Buffer): Promise<string> {
  const batch = batches.create({ source: 'zip' });
  batches.zipBegin(batch.id, { name: 'books.zip', size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += 8 * KiB) {
    batches.zipChunk(batch.id, offset, bytes.subarray(offset, offset + 8 * KiB).toString('base64'));
  }
  return batch.id;
}

describe('the real content check keeps every existing ceiling', () => {
  it('refuses an extraction larger than the batch budget before the worker writes it all', async () => {
    const file = join(dir, 'big.zip');
    // 60 books at ~5.6 KiB each is ~340 KiB of expansion against a 256 KiB
    // batch budget, so the byte ceiling is what must bite — not the item count.
    const bytes = await writeZip64(60, file, 1600);
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).rejects.toThrow();
    const after = lib.importBatches()[0];
    expect(after.items).toHaveLength(0);
    expect(after.zip?.failure).toBe('over_limit');
    // No tree is left behind and no staging file was produced.
    expect(readdirSync(batchDir(batchId)).filter((name) => name.endsWith('.extract'))).toHaveLength(0);
    expect(readdirSync(batchDir(batchId)).filter((name) => name.endsWith('.src'))).toHaveLength(0);
  });

  it('never measures more than the batch directory itself after a refusal', async () => {
    const file = join(dir, 'exact.zip');
    const bytes = await writeZip64(BATCH_ITEM_LIMIT + 30, file);
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).rejects.toThrow();
    // The only thing left is the archive: the tree was removed, not leaked.
    const entries = readdirSync(batchDir(batchId));
    expect(entries).toEqual(['source.zip']);
    expect(statSync(join(batchDir(batchId), 'source.zip')).size).toBe(bytes.length);
  });

  it('keeps the archive retryable after an unreadable-index refusal', async () => {
    const file = join(dir, 'retry.zip');
    const bytes = await writeZip64(BATCH_ITEM_LIMIT + 5, file);
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).rejects.toThrow();

    // A restart must not retry it forever: `over_limit` is skipped on resume, and
    // the record is still there for the user to split.
    await batches.shutdown();
    lib.close();
    await open();
    const report = batches.resume();
    expect(report.archives).toBe(0);
    expect(lib.importBatches()[0].zip?.state).toBe('ready');
    expect(lib.importBatches()[0].zip?.failure).toBe('over_limit');
    // The archive is still on disk and can be picked up by a new batch.
    expect(existsSync(join(batchDir(batchId), 'source.zip'))).toBe(true);
  });

  it('still refuses an unmeasurable disk instead of treating it as free space', async () => {
    const yazl = await import('yazl');
    const file = join(dir, 'ok.zip');
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('# 甲\n' + 'sea. '.repeat(60)), '甲.txt');
    zip.end();
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(file);
      out.on('close', () => resolve()).on('error', reject);
      zip.outputStream.pipe(out);
    });
    const batch = batches.create({ source: 'zip' });
    const bytes = readFileSync(file);
    batches.zipBegin(batch.id, { name: 'ok.zip', size: bytes.length });
    batches.zipChunk(batch.id, 0, bytes.toString('base64'));

    // Swap in a disk probe that cannot measure anything. The archive is already
    // verified, so this isolates the disk rule from the upload.
    await batches.shutdown();
    lib.close();
    lib = new Library({ dataDir: dir, now });
    lib.open();
    batches = new ImportBatches(lib, join(dir, 'transfers'), { now, budget: BUDGET, diskFree: () => null });
    await expect(batches.zipFinish(batch.id)).rejects.toThrow('无法测量');
    expect(lib.importBatches()[0].zip?.failure).toBe('disk');
    // Conservative: nothing was extracted, and the archive is kept.
    expect(existsSync(join(batchDir(batch.id), 'source.zip'))).toBe(true);
    expect(readdirSync(batchDir(batch.id)).filter((name) => name.endsWith('.extract'))).toHaveLength(0);
  });
});

describe('the persisted refusal reloads honestly', () => {
  it('round-trips through validateBatches with nulls for unknown figures', async () => {
    const file = join(dir, 'persist.zip');
    const bytes = await writeZip64(BATCH_ITEM_LIMIT + 10, file);
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).rejects.toThrow();

    const raw = lib.importBatches();
    const reloaded = validateBatches(JSON.parse(JSON.stringify(raw)), time);
    expect(reloaded).toHaveLength(1);
    const rejection = reloaded[0].zip?.rejection;
    expect(rejection?.kind).toBe('count');
    expect(rejection?.measured).toBe(true);
    expect(rejection?.books).toBe(BATCH_ITEM_LIMIT + 10);
    expect(rejection?.limit).toBe(BATCH_ITEM_LIMIT);
    expect(rejection?.partiallyStaged).toBe(false);
    expect(rejection?.archiveKept).toBe(true);
    expect(rejection?.nextStep).toBeTruthy();
    expect(reloaded[0].schema).toBe(BATCH_SCHEMA);
  });

  it('accepts a worker-cap refusal whose book count is honestly unknown', () => {
    // No file list means no book count: the record must say null, not 0.
    const batch = batches.create({ source: 'zip' });
    lib.updateImportBatch(batch.id, (draft) => {
      // A brand-new zip batch has no archive record yet; this test needs one.
      draft.zip = {
        name: 'a.zip', size: 1, state: 'ready',
        rejection: {
          kind: 'bytes', reason: '测试用超限记录', measured: false,
          totalBytes: null, budgetBytes: 1024, books: null, limit: BATCH_ITEM_LIMIT,
          accepted: 0, partiallyStaged: false, archiveKept: true, names: [], nextStep: '拆分后重试',
        },
      };
    });
    const reloaded = validateBatches(JSON.parse(JSON.stringify(lib.importBatches())), time);
    const rejection = reloaded[0].zip?.rejection;
    expect(rejection?.books).toBeNull();
    expect(rejection?.totalBytes).toBeNull();
    // The report says "incomplete" precisely because nothing is known.
    const report = batches.status(batch.id).report;
    expect(report.incomplete).toBe(true);
    expect(report.archiveRejected?.books).toBeNull();
    expect(report.archiveRejected?.measured).toBe(false);
  });

  it('rejects a persisted refusal that fabricates its invariants', () => {
    const base = {
      kind: 'count', reason: 'r', measured: true, totalBytes: 1, budgetBytes: 1, books: 1,
      limit: BATCH_ITEM_LIMIT, accepted: 0, partiallyStaged: false, archiveKept: true, names: [], nextStep: 'n',
    };
    const batch = {
      schema: BATCH_SCHEMA, id: '00000000-0000-4000-8000-000000000001', createdAt: 0, updatedAt: 0,
      source: 'zip' as const, status: 'preview' as const, toPlan: false, items: [],
      zip: { name: 'a.zip', size: 1, state: 'ready' as const, rejection: { ...base, kind: 'nonsense' } },
    };
    expect(() => validateBatches([batch])).toThrow('rejection kind');
    // "Some books were staged" contradicts the whole-archive rule.
    expect(() => validateBatches([{ ...batch, zip: { ...batch.zip, rejection: { ...base, partiallyStaged: true } } }]))
      .toThrow('invariants');
    // A negative or fractional book count is not a measurement.
    expect(() => validateBatches([{ ...batch, zip: { ...batch.zip, rejection: { ...base, books: -1 } } }]))
      .toThrow('figure');
  });
});