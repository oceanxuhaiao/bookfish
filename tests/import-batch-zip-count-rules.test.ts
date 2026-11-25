import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { ImportBatches } from '../src/import-batches.ts';
import { BATCH_ITEM_LIMIT } from '../src/import-batch.ts';

/**
 * "How many books did the archive actually contain?" has to be answered with the
 * SAME rules a normal import uses, or the content check becomes a second, subtly
 * different definition of "a book".
 *
 * The archive below mixes every shape that must NOT count: a directory, a hidden
 * tooling folder, unsupported formats, a case-duplicate path, an oversized book
 * and a nested series layout. Only the real, distinct, supported novels count.
 */
let dir: string, lib: Library, batches: ImportBatches, time: number;
const now = () => time;
const KiB = 1024;
const BUDGET = { batchBytes: 4096 * KiB, fileBytes: 8 * KiB, zipBytes: 1024 * KiB, workspaceBytes: 8192 * KiB };

async function open() {
  if (lib) { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } }
  lib = new Library({ dataDir: dir, now });
  lib.open();
  batches = new ImportBatches(lib, join(dir, 'transfers'), { now, budget: BUDGET });
}

beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'bookfish-zip-count-')); time = Date.parse('2026-10-13T08:00:00Z'); await open(); });
afterEach(async () => { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

const batchDir = (id: string) => join(dir, 'transfers', 'batches', id);
const body = (seed: string): Buffer => Buffer.from(`# ${seed}\n` + `${seed} text. `.repeat(40));

async function writeZip64(entries: [string, Buffer][], file: string): Promise<Buffer> {
  const yazl = await import('yazl');
  const base = file + '.base';
  const zip = new yazl.ZipFile();
  for (const [name, entry] of entries) zip.addBuffer(entry, name);
  for (const name of ['空目录/', '__MACOSX/']) {
    (zip as unknown as { addEmptyDirectory(n: string): void }).addEmptyDirectory(name);
  }
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(base);
    out.on('close', () => resolve()).on('error', reject);
    zip.outputStream.pipe(out);
  });
  let buffer = readFileSync(base);
  const eocdAt = buffer.length - 22;
  const entriesCount = buffer.readUInt16LE(eocdAt + 10);
  const cdSize = buffer.readUInt32LE(eocdAt + 12);
  const cdOffset = buffer.readUInt32LE(eocdAt + 16);
  const record = Buffer.alloc(76);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(entriesCount), 24); record.writeBigUInt64LE(BigInt(entriesCount), 32);
  record.writeBigUInt64LE(BigInt(cdSize), 40); record.writeBigUInt64LE(BigInt(cdOffset), 48);
  record.writeUInt32LE(0x07064b50, 56);
  record.writeBigUInt64LE(BigInt(cdOffset + cdSize), 64); record.writeUInt32LE(1, 72);
  const tail = Buffer.from(buffer.subarray(eocdAt));
  tail.writeUInt16LE(0xffff, 10); tail.writeUInt32LE(0xffffffff, 12); tail.writeUInt32LE(0xffffffff, 16);
  buffer = Buffer.concat([buffer.subarray(0, eocdAt), record, tail]);
  writeFileSync(file, buffer);
  return buffer;
}

async function startArchive(bytes: Buffer): Promise<string> {
  const batch = batches.create({ source: 'zip' });
  batches.zipBegin(batch.id, { name: 'books.zip', size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += 8 * KiB) {
    batches.zipChunk(batch.id, offset, bytes.subarray(offset, offset + 8 * KiB).toString('base64'));
  }
  return batch.id;
}

/** A plain classic ZIP: the central directory stays readable, so the index
 * precheck runs and can name what it refuses. */
async function writeParis(entries: [string, Buffer][], file: string): Promise<Buffer> {
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

describe('the actual book count follows the import rules exactly', () => {
  it('ignores directories, hidden files and unsupported formats', async () => {
    const file = join(dir, 'mixed.zip');
    const entries: [string, Buffer][] = [
      ['系列/第一部/正文.txt', body('a')],
      ['系列/第二部/正文.md', body('b')],
      ['系列/第二部/正文.epub', body('c')],
      ['封面.jpg', Buffer.from('jpg')],
      ['插图.png', Buffer.from('png')],
      ['__MACOSX/._正文.txt', Buffer.from('meta')],
      ['.DS_Store', Buffer.from('junk')],
      ['第三部.txt', body('d')],
    ];
    const bytes = await writeZip64(entries, file);
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).resolves.toBeTruthy();

    const after = lib.importBatches()[0];
    // Four real novels: the three nested ones plus one top-level book.
    expect(after.items).toHaveLength(4);
    // Default string sort is by UTF-16 code unit, so 第三部 (U+7B2C) sorts before
    // 系列 (U+7CFB) — the archive order is not the expected order.
    expect(after.items.map((item) => item.name).sort()).toEqual([
      '第三部.txt', '系列/第一部/正文.txt', '系列/第二部/正文.epub', '系列/第二部/正文.md',
    ]);
    // Refusals are reported, not dropped.
    const report = batches.status(batchId).report;
    expect(report.unsupported).toBe(2);
    expect(report.rejectedNames.unsupported).toContain('封面.jpg');
    expect(report.incomplete).toBe(true);
    // The hidden tooling files never became books.
    expect(after.items.some((item) => item.name.includes('__MACOSX'))).toBe(false);
    expect(after.items.some((item) => item.name.startsWith('.'))).toBe(false);
  });

  it('refuses a case-colliding archive exactly like the worker already did', async () => {
    // yauzl strictness is a pre-existing safety rule, not a v1.5 change: two
    // entries whose names differ only by case would collide on a
    // case-insensitive filesystem. The archive is refused whole and kept.
    const file = join(dir, 'case.zip');
    const entries: [string, Buffer][] = [
      ['同名.TXT', body('upper')], ['同名.txt', body('lower')], ['甲.txt', body('a')],
    ];
    const bytes = await writeZip64(entries, file);
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).rejects.toThrow();
    const after = lib.importBatches()[0];
    expect(after.items).toHaveLength(0);
    expect(existsSync(join(batchDir(batchId), 'source.zip'))).toBe(true);
    expect(readdirSync(batchDir(batchId)).filter((name) => name.endsWith('.extract'))).toHaveLength(0);
  });

  it('refuses the whole archive when one entry exceeds the per-book ceiling', async () => {
    // The extraction worker aborts the entire package on an oversized entry, so
    // "import the other nine and drop the big one" is not available. v1.5 turns
    // that into an explicit whole-archive refusal instead of a silent partial.
    // A readable index means the refusal can name the offending entry.
    const file = join(dir, 'oversized.zip');
    const oversized = Buffer.from('x'.repeat(9 * KiB));  // over the 8 KiB book ceiling
    const entries: [string, Buffer][] = [
      ['甲.txt', body('a')],
      ['超大.txt', oversized],
      ['乙.txt', body('b')],
    ];
    const bytes = await writeParis(entries, file);
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).rejects.toThrow();
    const after = lib.importBatches()[0];
    expect(after.items).toHaveLength(0);
    expect(after.zip?.failure).toBe('over_limit');
    // The index knew which entry was too big, so the record names it.
    expect(after.zip?.rejection?.kind).toBe('entry');
    expect(after.zip?.rejection?.names).toContain('超大.txt');
    expect(after.zip?.rejection?.partiallyStaged).toBe(false);
    expect(after.zip?.rejection?.books).toBe(3);
    expect(existsSync(join(batchDir(batchId), 'source.zip'))).toBe(true);
    expect(readdirSync(batchDir(batchId)).filter((name) => name.endsWith('.extract'))).toHaveLength(0);
  });

  it('refuses a ZIP64 archive with an oversized entry without inventing a book count', async () => {
    // Same rule, unreadable index: the ceiling is enforced by the extraction
    // worker instead of the precheck. No file list was ever produced, so the
    // record must say "unknown" rather than claimed names or a made-up count.
    const file = join(dir, 'oversized-zip64.zip');
    const oversized = Buffer.from('x'.repeat(9 * KiB));
    const bytes = await writeZip64([
      ['甲.txt', body('a')], ['超大.txt', oversized], ['乙.txt', body('b')],
    ], file);
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).rejects.toThrow();
    const after = lib.importBatches()[0];
    expect(after.items).toHaveLength(0);
    expect(after.zip?.failure).toBe('over_limit');
    expect(after.zip?.rejection?.kind).toBe('entry');
    expect(after.zip?.rejection?.measured).toBe(false);
    expect(after.zip?.rejection?.books).toBeNull();
    expect(after.zip?.rejection?.partiallyStaged).toBe(false);
    expect(after.zip?.rejection?.archiveKept).toBe(true);
    expect(existsSync(join(batchDir(batchId), 'source.zip'))).toBe(true);
    expect(readdirSync(batchDir(batchId)).filter((name) => name.endsWith('.extract'))).toHaveLength(0);
  });

  it('honours the batch when it already holds staged entries (a retry)', async () => {
    const file = join(dir, 'retry.zip');
    const entries: [string, Buffer][] = Array.from({ length: BATCH_ITEM_LIMIT },
      (_, index) => [`书${String(index + 1).padStart(3, '0')}.txt`, body(`s${index}`)] as [string, Buffer]);
    const bytes = await writeZip64(entries, file);

    const batch = batches.create({ source: 'zip' });
    // A previous attempt already accepted 99 of the books: the archive may only
    // supply the one that is missing, not a fresh 100.
    const staged = await batches.addItems(batch.id, entries.slice(0, 99)
      .map(([name, entry]) => ({ name, size: entry.length })));
    expect(staged.added).toHaveLength(99);
    batches.zipBegin(batch.id, { name: 'books.zip', size: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += 8 * KiB) {
      batches.zipChunk(batch.id, offset, bytes.subarray(offset, offset + 8 * KiB).toString('base64'));
    }
    await expect(batches.zipFinish(batch.id)).resolves.toBeTruthy();
    const after = lib.importBatches()[0];
    // 99 names were already taken, so the extraction added exactly the 1 missing.
    expect(after.items).toHaveLength(BATCH_ITEM_LIMIT);
    expect(new Set(after.items.map((item) => item.name)).size).toBe(BATCH_ITEM_LIMIT);
    // The 99 re-offered names are duplicates, and the report says so.
    const report = batches.status(batch.id).report;
    expect(report.duplicate).toBe(99);
  });

  it('reports what an archive offered but could not take as over-budget', async () => {
    // A tight batch budget: the archive is inside the count limit but its
    // expansion does not fit, which the extraction measures for real.
    const file = join(dir, 'tight.zip');
    const entries: [string, Buffer][] = [
      ['甲.txt', body('a')], ['乙.txt', body('b')], ['丙.txt', body('c')],
    ];
    const bytes = await writeZip64(entries, file);
    await batches.shutdown();
    lib.close();
    lib = new Library({ dataDir: dir, now });
    lib.open();
    batches = new ImportBatches(lib, join(dir, 'transfers'), {
      now, budget: { ...BUDGET, batchBytes: 512, workspaceBytes: 2048 * KiB },
    });
    const batchId = await startArchive(bytes);
    await expect(batches.zipFinish(batchId)).rejects.toThrow();
    const after = lib.importBatches()[0];
    expect(after.items).toHaveLength(0);
    expect(after.zip?.failure).toBe('over_limit');
    expect(after.zip?.rejection?.kind).toBe('bytes');
    // `books` is null here: the extraction was refused before any file list.
    expect(after.zip?.rejection?.books).toBeNull();
    expect(existsSync(join(batchDir(batchId), 'source.zip'))).toBe(true);
    expect(readdirSync(batchDir(batchId)).filter((name) => name.endsWith('.extract'))).toHaveLength(0);
  });
});