import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import yazl from 'yazl';
import { Library } from '../src/library.ts';
import { ImportBatches, readZipPlan } from '../src/import-batches.ts';
import { BATCH_ITEM_LIMIT } from '../src/import-batch.ts';

/**
 * v1.5: an archive whose central directory cannot be read must not become a
 * partial import.
 *
 * Every fixture here is a REAL, valid ZIP that the extraction worker unpacks
 * without complaint — the index is what fails, not the archive. Mocking
 * `readZipPlan` to return null would prove nothing about the guarantee, since
 * the whole point is that the second (real) check catches what the index could
 * not.
 */
let dir: string, lib: Library, batches: ImportBatches, time: number;
const now = () => time;
const KiB = 1024;

const BUDGET = { batchBytes: 1024 * KiB, fileBytes: 512 * KiB, zipBytes: 512 * KiB, workspaceBytes: 2048 * KiB };

async function open(budget: Partial<typeof BUDGET> = BUDGET) {
  if (lib) { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } }
  lib = new Library({ dataDir: dir, now });
  lib.open();
  batches = new ImportBatches(lib, join(dir, 'transfers'), { now, budget });
}

beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'bookfish-zip-unknown-')); time = Date.parse('2026-10-13T08:00:00Z'); await open(); });
afterEach(async () => { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

const batchDir = (id: string) => join(dir, 'transfers', 'batches', id);
const zipPath = (id: string) => join(batchDir(id), 'source.zip');

const body = (seed: string): Buffer => Buffer.from(`# ${seed}\n` + `${seed} text. `.repeat(30));
const many = (count: number): [string, Buffer][] => Array.from({ length: count },
  (_, index) => [`书${String(index + 1).padStart(3, '0')}.txt`, body(`s${index}`)]);

async function writeZip(entries: [string, Buffer][], file: string): Promise<Buffer> {
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

/**
 * Turn a valid archive into a valid ZIP64 one.
 *
 * A real ZIP64 end-of-central-directory record and locator are inserted, and
 * the classic record's count/size/offset are replaced by their 0xFFFF /
 * 0xFFFFFFFF escape markers — exactly what a writer emits when it cannot fit a
 * value. `readZipPlan` refuses to guess and returns null; yauzl follows the
 * ZIP64 record and extracts every entry. That is the honest "unknown index,
 * perfectly readable archive" case.
 */
async function writeZip64(entries: [string, Buffer][], file: string): Promise<Buffer> {
  const base = file + '.base';
  const buffer = await writeZip(entries, base);
  const eocdAt = buffer.length - 22;
  const count = buffer.readUInt16LE(eocdAt + 10);
  const cdSize = buffer.readUInt32LE(eocdAt + 12);
  const cdOffset = buffer.readUInt32LE(eocdAt + 16);
  const record = Buffer.alloc(76);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(0n, 24); record.writeBigUInt64LE(BigInt(count), 24); record.writeBigUInt64LE(BigInt(count), 32);
  record.writeBigUInt64LE(BigInt(cdSize), 40); record.writeBigUInt64LE(BigInt(cdOffset), 48);
  record.writeUInt32LE(0x07064b50, 56);
  record.writeBigUInt64LE(BigInt(cdOffset + cdSize), 64);
  record.writeUInt32LE(1, 72);
  const tail = Buffer.from(buffer.subarray(eocdAt));
  tail.writeUInt16LE(0xffff, 10);
  tail.writeUInt32LE(0xffffffff, 12);
  tail.writeUInt32LE(0xffffffff, 16);
  const patched = Buffer.concat([buffer.subarray(0, eocdAt), record, tail]);
  writeFileSync(file, patched);
  return patched;
}

/** A valid archive whose central directory is far larger than the 8 MiB cap. */
async function writeHugeIndex(count: number, file: string): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, entry] of many(count)) {
    // `addBuffer`'s public type omits `fileComment`, but the runtime honours it.
    // A 64 KiB comment per entry is how a real archive grows a huge index while
    // staying perfectly readable.
    (zip as unknown as { addBuffer(b: Buffer, p: string, o?: { fileComment?: string }): void })
      .addBuffer(entry, name, { fileComment: 'x'.repeat(0xfff0) });
  }
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

async function startArchive(bytes: Buffer): Promise<string> {
  const batch = batches.create({ source: 'zip' });
  batches.zipBegin(batch.id, { name: 'books.zip', size: bytes.length });
  upload(batch.id, bytes);
  return batch.id;
}

const extractDirs = (batchId: string) => readdirSync(batchDir(batchId)).filter((name) => name.endsWith('.extract'));

describe('an unreadable index still cannot smuggle a partial import', () => {
  it('accepts 99 books in a ZIP64 archive whose index cannot be read', async () => {
    const file = join(dir, 'z64-99.zip');
    const bytes = await writeZip64(many(99), file);
    // The premise: the archive is real and the pre-parser cannot read it.
    expect(readZipPlan(file)).toBeNull();
    const batchId = await startArchive(bytes);
    const result = await batches.zipFinish(batchId);
    expect(result.added).toHaveLength(99);
    expect(lib.importBatches()[0].zip?.state).toBe('extracted');
    expect(lib.importBatches()[0].items).toHaveLength(99);
  });

  it(`accepts exactly ${BATCH_ITEM_LIMIT} books in a ZIP64 archive`, async () => {
    const file = join(dir, 'z64-100.zip');
    const bytes = await writeZip64(many(BATCH_ITEM_LIMIT), file);
    expect(readZipPlan(file)).toBeNull();
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).resolves.toBeTruthy();
    expect(lib.importBatches()[0].items).toHaveLength(BATCH_ITEM_LIMIT);
    expect(batches.status(batchId).report.overflow).toBe(0);
  });

  it(`refuses ${BATCH_ITEM_LIMIT + 1} books with a zero-item batch`, async () => {
    const file = join(dir, 'z64-101.zip');
    const bytes = await writeZip64(many(BATCH_ITEM_LIMIT + 1), file);
    expect(readZipPlan(file)).toBeNull();
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).rejects.toThrow('超过单批');
    const after = lib.importBatches()[0];
    // The core promise: nothing was accepted, so nothing can be half-imported.
    expect(after.items).toHaveLength(0);
    expect(after.zip?.failure).toBe('over_limit');
    expect(existsSync(zipPath(batchId))).toBe(true);
    expect(after.zip?.rejection?.kind).toBe('count');
    expect(after.zip?.rejection?.measured).toBe(true);
    expect(after.zip?.rejection?.books).toBe(BATCH_ITEM_LIMIT + 1);
    expect(after.zip?.rejection?.partiallyStaged).toBe(false);
    expect(batches.status(batchId).report.incomplete).toBe(true);
  });

  it('refuses 120 books in a ZIP64 archive', async () => {
    const file = join(dir, 'z64-120.zip');
    const bytes = await writeZip64(many(BATCH_ITEM_LIMIT + 20), file);
    expect(readZipPlan(file)).toBeNull();
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).rejects.toThrow('超过单批');
    expect(lib.importBatches()[0].items).toHaveLength(0);
    expect(lib.importBatches()[0].zip?.rejection?.books).toBe(BATCH_ITEM_LIMIT + 20);
  });

  it('refuses books behind a central directory over the 8 MiB cap', async () => {
    const file = join(dir, 'huge-index.zip');
    // 65 534-byte entry comments: each entry costs >64 KiB of index, so 128 of
    // them push the central directory past the 8 MiB the pre-parser will read.
    // The archive itself stays under the 512 KiB... 2 MiB raw ceiling below.
    await open({ ...BUDGET, zipBytes: 16 * 1024 * KiB, workspaceBytes: 64 * 1024 * KiB });
    const count = 128;
    const bytes = await writeHugeIndex(count, file);
    expect(statSync(file).size).toBeGreaterThan(8 * 1024 * 1024);
    // The archive is valid; only its index is beyond what the precheck accepts.
    expect(readZipPlan(file)).toBeNull();
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).rejects.toThrow('超过单批');
    expect(lib.importBatches()[0].items).toHaveLength(0);
    expect(lib.importBatches()[0].zip?.failure).toBe('over_limit');
    expect(lib.importBatches()[0].zip?.rejection?.books).toBe(count);
    expect(existsSync(zipPath(batchId))).toBe(true);
  });
});

describe('a refused archive leaves no trace except the archive itself', () => {
  it('keeps the ZIP byte-identical, creates no staging file and clears the tree', async () => {
    const file = join(dir, 'keep.zip');
    const bytes = await writeZip64(many(BATCH_ITEM_LIMIT + 20), file);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).rejects.toThrow();

    // 1. The original archive is still there, byte for byte.
    expect(existsSync(zipPath(batchId))).toBe(true);
    expect(createHash('sha256').update(readFileSync(zipPath(batchId))).digest('hex')).toBe(digest);
    // 2. No staging file was ever produced.
    expect(readdirSync(batchDir(batchId)).filter((name) => name.endsWith('.src'))).toHaveLength(0);
    // 3. The isolated extraction directory was cleaned up.
    expect(extractDirs(batchId)).toHaveLength(0);
    // 4. Nothing reached the library.
    expect(lib.list()).toHaveLength(0);
    // 5. The refusal is persisted, so it survives a restart.
    const persisted = lib.importBatches()[0].zip?.rejection;
    expect(persisted?.archiveKept).toBe(true);
    expect(persisted?.accepted).toBe(0);
    expect(persisted?.reason).toContain('超过单批');
    expect(persisted?.nextStep).toBeTruthy();
  });

  it('reports the actual books found, not a fabricated figure', async () => {
    const file = join(dir, 'names.zip');
    const bytes = await writeZip64(many(BATCH_ITEM_LIMIT + 5), file);
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).rejects.toThrow();
    const rejection = batches.status(batchId).report.archiveRejected;
    expect(rejection?.books).toBe(BATCH_ITEM_LIMIT + 5);
    // The names past the limit are exactly the ones the user must move out.
    expect(rejection?.names.length).toBeGreaterThan(0);
    expect(rejection?.names.every((name) => /\.txt$/u.test(name))).toBe(true);
  });

  it('still refuses an archive that expands past the batch budget', async () => {
    // 40 books stay inside the count limit but blow the byte ceiling: ~2 KiB
    // each is ~80 KiB of expansion against a 64 KiB batch budget.
    await open({ ...BUDGET, batchBytes: 64 * KiB, workspaceBytes: 512 * KiB + 64 * KiB, zipBytes: 512 * KiB });
    const file = join(dir, 'bytes.zip');
    const fat = (seed: string): Buffer => Buffer.from(`# ${seed}\n` + `${seed} text. `.repeat(220));
    const bytes = await writeZip64(Array.from({ length: 40 }, (_, index) =>
      [`书${String(index + 1).padStart(3, '0')}.txt`, fat(`s${index}`)] as [string, Buffer]), file);
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).rejects.toThrow();
    const after = lib.importBatches()[0];
    expect(after.items).toHaveLength(0);
    expect(after.zip?.failure).toBe('over_limit');
    expect(after.zip?.rejection?.kind).toBe('bytes');
    expect(existsSync(zipPath(batchId))).toBe(true);
    expect(extractDirs(batchId)).toHaveLength(0);
  });
});

describe('the counts that a readable index provides are marked unmeasured', () => {
  it('labels an index-derived count refusal as not measured', async () => {
    const file = join(dir, 'indexed.zip');
    const bytes = await writeZip(BATCH_ITEM_LIMIT + 20 > 100 ? many(BATCH_ITEM_LIMIT + 20) : [], file);
    // A plain archive: the index IS readable, so no extraction is needed to know.
    expect(readZipPlan(file)).not.toBeNull();
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).rejects.toThrow('超过单批');
    const rejection = lib.importBatches()[0].zip?.rejection;
    expect(rejection?.kind).toBe('count');
    expect(rejection?.measured).toBe(false);
    expect(rejection?.books).toBe(BATCH_ITEM_LIMIT + 20);
    // The report counts the overflow in the same bucket as always.
    expect(batches.status(batchId).report.overflow).toBe(20);
  });

  it('records no rejection object for a successful archive', async () => {
    const file = join(dir, 'fine.zip');
    const bytes = await writeZip(many(3), file);
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).resolves.toBeTruthy();
    expect(lib.importBatches()[0].zip?.rejection).toBeUndefined();
    expect(batches.status(batchId).report.archiveRejected).toBeNull();
    expect(batches.status(batchId).report.incomplete).toBe(false);
  });
});