import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWriteStream, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { ImportBatches, dirTreeBytes } from '../src/import-batches.ts';

let dir: string, lib: Library, batches: ImportBatches, time: number;
const now = () => time;
const KiB = 1024;

const BUDGET = { batchBytes: 64 * KiB, fileBytes: 32 * KiB, zipBytes: 16 * KiB, workspaceBytes: 80 * KiB };

async function open(budget: Partial<typeof BUDGET> = BUDGET) {
  if (lib) { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } }
  lib = new Library({ dataDir: dir, now });
  lib.open();
  batches = new ImportBatches(lib, join(dir, 'transfers'), { now, budget });
}

beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'bookfish-zip-nest-')); time = Date.parse('2026-10-13T08:00:00Z'); await open(); });
afterEach(async () => { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

const batchDir = (id: string) => join(dir, 'transfers', 'batches', id);

/**
 * An INDEPENDENT recursive counter for the test side. It must not import or
 * mimic the module's own walk: the whole point is a second opinion.
 */
function treeBytesAt(root: string): number {
  if (!existsSync(root)) return 0;
  let total = 0;
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const stat = lstatSync(full);
    if (stat.isDirectory()) total += treeBytesAt(full);
    else if (stat.isFile()) total += stat.size;
  }
  return total;
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

/** The acceptance layout from the task: three levels of directories. */
const nestedBooks = (): [string, Buffer][] => [
  ['系列/第一部/正文/甲.txt', body('甲')],
  ['系列/第二部/正文/乙.txt', body('乙')],
];

async function uploadArchive(batchId: string, file: string) {
  const bytes = readFileSync(file);
  batches.zipBegin(batchId, { name: 'books.zip', size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += 8 * KiB) {
    batches.zipChunk(batchId, offset, bytes.subarray(offset, offset + 8 * KiB).toString('base64'));
  }
  return batches.zipFinish(batchId);
}

describe('nested archive layouts are counted recursively', () => {
  it('counts every file at three levels of nesting, before and after extraction', async () => {
    const file = join(dir, 'nested.zip');
    const zipSize = await makeZip(nestedBooks(), file);
    const treeSize = nestedBooks().reduce((total, [, bytes]) => total + bytes.length, 0);
    const batch = batches.create({ source: 'zip' });

    batches.zipBegin(batch.id, { name: 'books.zip', size: zipSize });
    const bytes = readFileSync(file);
    batches.zipChunk(batch.id, 0, bytes.toString('base64'));
    // One level only: the zip itself.
    expect(treeBytesAt(batchDir(batch.id))).toBe(zipSize);

    await uploadArchive(batch.id, file);
    const after = lib.importBatches()[0];
    expect(after.zip?.state).toBe('extracted');
    // The peak must include EVERY nested file, not just the first level.
    expect(after.zip?.peakBytes).toBeGreaterThanOrEqual(zipSize + treeSize);
    expect(after.zip!.peakBytes!).toBeLessThanOrEqual(BUDGET.workspaceBytes);
    // The independent counter agrees with the module's recursive walk.
    expect(treeBytesAt(batchDir(batch.id))).toBe(treeSize);
    expect(dirTreeBytes(batchDir(batch.id))).toBe(treeBytesAt(batchDir(batch.id)));
    expect(after.items).toHaveLength(2);
    expect(after.items.every((item) => item.staged)).toBe(true);
  });

  it('does not let nested directories bypass the disk budget', async () => {
    const file = join(dir, 'nested.zip');
    const zipSize = await makeZip(nestedBooks(), file);
    const treeSize = nestedBooks().reduce((total, [, bytes]) => total + bytes.length, 0);
    // The tree cannot fit: the worker must refuse before writing it all.
    await open({ ...BUDGET, batchBytes: 4 * KiB, workspaceBytes: 24 * KiB });
    const batch = batches.create({ source: 'zip' });
    await expect(uploadArchive(batch.id, file)).rejects.toThrow();
    const after = lib.importBatches()[0];
    // The verified archive stays for a retry; no partial tree, no staging files.
    expect(existsSync(join(batchDir(batch.id), 'source.zip'))).toBe(true);
    expect(after.zip?.state).toBe('ready');
    expect(after.items).toHaveLength(0);
    expect(treeBytesAt(batchDir(batch.id))).toBe(zipSize);
    // Sanity: the nested tree really is what the budget cannot hold.
    expect(treeSize).toBeGreaterThan(4 * KiB);
  });

  it('never follows a symlink planted inside a batch directory', () => {
    const batch = batches.create({ source: 'zip' });
    const root = batchDir(batch.id);
    mkdirSync(join(root, 'series'), { recursive: true });
    writeFileSync(join(root, 'series', 'real.txt'), Buffer.alloc(2048));
    // A symlink to a big file outside the tree must not be counted as content.
    const outside = join(dir, 'outside.bin');
    writeFileSync(outside, Buffer.alloc(64 * KiB, 1));
    let linked = false;
    try { symlinkSync(outside, join(root, 'series', 'link.bin')); linked = true; } catch { /* Windows without dev mode: the guard still holds */ }
    const total = dirTreeBytes(root);
    expect(total).toBe(2048);
    if (linked) rmSync(join(root, 'series', 'link.bin'), { force: true });
  });

  it('a vanished mid-walk path is skipped, not treated as zero for everything', async () => {
    const batch = batches.create({ source: 'zip' });
    const root = batchDir(batch.id);
    mkdirSync(join(root, 'gone', 'deep'), { recursive: true });
    writeFileSync(join(root, 'gone', 'deep', 'a.txt'), Buffer.alloc(1024));
    writeFileSync(join(root, 'stay.txt'), Buffer.alloc(512));
    // Race simulation: the file disappears between listing and statting.
    const names = readdirSync(join(root, 'gone', 'deep'));
    rmSync(join(root, 'gone', 'deep', names[0]!), { force: true });
    expect(dirTreeBytes(root)).toBe(512);
  });
});
