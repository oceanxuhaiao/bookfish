import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { ImportBatches } from '../src/import-batches.ts';

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

beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'bookfish-zip-empty-')); time = Date.parse('2026-10-13T08:00:00Z'); await open(); });
afterEach(async () => { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

const batchDir = (id: string) => join(dir, 'transfers', 'batches', id);

async function makeZip(entries: [string, Buffer][], file: string): Promise<number> {
  const yazl = await import('yazl');
  const zip = new yazl.ZipFile();
  for (const [name, body] of entries) zip.addBuffer(body, name);
  // No entries at all is a valid ZIP: end() writes an empty central directory.
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(file);
    out.on('close', () => resolve()).on('error', reject);
    zip.outputStream.pipe(out);
  });
  return statSync(file).size;
}

async function uploadArchive(batchId: string, file: string) {
  const bytes = readFileSync(file);
  batches.zipBegin(batchId, { name: 'books.zip', size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += 8 * KiB) {
    batches.zipChunk(batchId, offset, bytes.subarray(offset, offset + 8 * KiB).toString('base64'));
  }
  return batches.zipFinish(batchId);
}

const body = (seed: string): Buffer => Buffer.from(`# ${seed}\n` + `${seed} the tide is low. `.repeat(360));

describe('archives with nothing importable reach a terminal state', () => {
  it('an empty ZIP completes, is never re-extracted, and never joins the plan', async () => {
    const file = join(dir, 'empty.zip');
    const zipSize = await makeZip([], file);
    expect(zipSize).toBeGreaterThan(0);
    const batch = batches.create({ source: 'zip' });
    const result = await uploadArchive(batch.id, file);
    expect(result.added).toHaveLength(0);
    const after = lib.importBatches()[0];
    // Terminal: the extraction finished, there simply was nothing in it.
    expect(after.zip?.state).toBe('extracted');
    expect(after.status).toBe('completed');
    expect(after.items).toHaveLength(0);
    expect(after.toPlan).toBe(false);
    // The archive copy and any tree are gone; the record can be forgotten.
    expect(existsSync(join(batchDir(batch.id), 'source.zip'))).toBe(false);
    expect(readdirSync(batchDir(batch.id)).filter((name) => name.endsWith('.src') || name.endsWith('.extract'))).toHaveLength(0);

    // A restart must not touch this batch again: it is already terminal.
    await batches.shutdown();
    lib.close();
    await open();
    const report = batches.resume();
    expect(report.archives).toBe(0);
    expect(lib.importBatches()[0].zip?.state).toBe('extracted');
    expect(lib.importBatches()[0].status).toBe('completed');
  });

  it('only hidden files complete as a terminal empty result', async () => {
    const file = join(dir, 'hidden.zip');
    await makeZip([['__MACOSX/._junk', Buffer.from('noise')], ['.DS_Store', Buffer.from('junk')]], file);
    const batch = batches.create({ source: 'zip' });
    const result = await uploadArchive(batch.id, file);
    expect(result.added).toHaveLength(0);
    const after = lib.importBatches()[0];
    expect(after.zip?.state).toBe('extracted');
    expect(after.status).toBe('completed');
    expect(after.items).toHaveLength(0);
  });

  it('only unsupported formats completes and reports what was skipped', async () => {
    const file = join(dir, 'unsupported.zip');
    await makeZip([['封面.png', Buffer.from('png')], ['说明.pdf.sig', Buffer.from('sig')]], file);
    const batch = batches.create({ source: 'zip' });
    const result = await uploadArchive(batch.id, file);
    expect(result.added).toHaveLength(0);
    expect(result.unsupported.length).toBeGreaterThan(0);
    const after = lib.importBatches()[0];
    expect(after.zip?.state).toBe('extracted');
    expect(after.status).toBe('completed');
    expect(after.items).toHaveLength(0);
  });

  it('directories without files complete as a terminal empty result', async () => {
    const file = join(dir, 'dirs.zip');
    // yazl can add empty directories.
    const yazl = await import('yazl');
    const zip = new yazl.ZipFile();
    (zip as unknown as { addEmptyDirectory(name: string): void }).addEmptyDirectory('系列/第一部');
    (zip as unknown as { addEmptyDirectory(name: string): void }).addEmptyDirectory('系列/第二部');
    zip.end();
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(file);
      out.on('close', () => resolve()).on('error', reject);
      zip.outputStream.pipe(out);
    });
    const batch = batches.create({ source: 'zip' });
    await expect(uploadArchive(batch.id, file)).resolves.toBeTruthy();
    const after = lib.importBatches()[0];
    expect(after.zip?.state).toBe('extracted');
    expect(after.status).toBe('completed');
    expect(after.items).toHaveLength(0);
  });

  it('a mixed archive still extracts the supported book normally', async () => {
    const file = join(dir, 'mixed.zip');
    await makeZip([['甲.txt', body('甲')], ['.DS_Store', Buffer.from('junk')]], file);
    const batch = batches.create({ source: 'zip' });
    await expect(uploadArchive(batch.id, file)).resolves.toBeTruthy();
    const after = lib.importBatches()[0];
    expect(after.zip?.state).toBe('extracted');
    expect(after.items).toHaveLength(1);
    expect(after.items[0]!.staged).toBeTruthy();
  });
});
