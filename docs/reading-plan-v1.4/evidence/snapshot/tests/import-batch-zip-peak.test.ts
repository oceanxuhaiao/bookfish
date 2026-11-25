import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWriteStream, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Library } from '../src/library.ts';
import { ImportBatches } from '../src/import-batches.ts';

let dir: string, lib: Library, batches: ImportBatches, time: number;
const now = () => time;
const KiB = 1024;

/**
 * A deliberately small budget so the real numbers are readable: three ~8 KiB
 * books, a 16 KiB archive ceiling and an 80 KiB workspace.
 */
const BUDGET = { batchBytes: 64 * KiB, fileBytes: 32 * KiB, zipBytes: 16 * KiB, workspaceBytes: 80 * KiB };

async function open(budget: Partial<typeof BUDGET> = BUDGET) {
  if (lib) { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } }
  lib = new Library({ dataDir: dir, now });
  lib.open();
  batches = new ImportBatches(lib, join(dir, 'transfers'), { now, budget });
}

beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'bookfish-zip-peak-')); time = Date.parse('2026-10-13T08:00:00Z'); await open(); });
afterEach(async () => { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

const batchDir = (id: string) => join(dir, 'transfers', 'batches', id);

/**
 * Everything the batch directory currently occupies, measured from disk.
 *
 * Deliberately an INDEPENDENT recursive implementation (not the module's own
 * helper, and not a copy of its code): the point of measuring in tests is to
 * catch the product's counter being wrong, which a shared implementation could
 * never do. Symlinks are not followed; directories carry no size of their own.
 */
function dirBytes(batchId: string): number {
  const root = batchDir(batchId);
  if (!existsSync(root)) return 0;
  const walk = (dir: string): number => {
    let total = 0;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stat = lstatSync(full);
      if (stat.isDirectory()) total += walk(full);
      else if (stat.isFile()) total += stat.size;
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

async function uploadArchive(batchId: string, file: string) {
  const bytes = readFileSync(file);
  batches.zipBegin(batchId, { name: 'books.zip', size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += 8 * KiB) {
    batches.zipChunk(batchId, offset, bytes.subarray(offset, offset + 8 * KiB).toString('base64'));
  }
  return batches.zipFinish(batchId);
}

const books = (): [string, Buffer][] => [
  ['甲.txt', Buffer.from('# 甲\n' + 'the sea is wide. '.repeat(420))],
  ['乙.txt', Buffer.from('# 乙\n' + 'the tide is low. '.repeat(420))],
  ['丙.txt', Buffer.from('# 丙\n' + 'the wind is cold. '.repeat(420))],
];

describe('the archive path keeps a real, measured disk ceiling', () => {
  it('reports each stage and never lets a third copy exist', async () => {
    const file = join(dir, 'books.zip');
    const zipSize = await makeZip(books(), file);
    const treeSize = books().reduce((total, [, body]) => total + body.length, 0);
    const batch = batches.create({ source: 'zip' });
    expect(dirBytes(batch.id)).toBe(0);

    // Stage 1: the archive alone.
    batches.zipBegin(batch.id, { name: 'books.zip', size: zipSize });
    expect(dirBytes(batch.id)).toBe(0);
    const bytes = readFileSync(file);
    batches.zipChunk(batch.id, 0, bytes.toString('base64'));
    expect(dirBytes(batch.id)).toBe(zipSize);

    // Stage 2: extraction. Archive + tree coexist exactly once.
    await batches.zipFinish(batch.id);
    const after = lib.importBatches()[0];
    expect(after.zip?.state).toBe('extracted');
    expect(after.zip?.peakBytes).toBeGreaterThanOrEqual(zipSize + treeSize);
    expect(after.zip?.peakBytes).toBeLessThanOrEqual(BUDGET.workspaceBytes);
    // The naive flow would have needed a second copy of every book.
    expect(after.zip!.peakBytes!).toBeLessThan(zipSize + treeSize * 2);

    // Stage 3: only staging files remain; the archive and the tree are gone.
    expect(existsSync(join(batchDir(batch.id), 'source.zip'))).toBe(false);
    expect(readdirSync(batchDir(batch.id)).some((name) => name.endsWith('.extract'))).toBe(false);
    expect(dirBytes(batch.id)).toBe(treeSize);
    expect(after.items.every((item) => item.staged)).toBe(true);
    expect(after.items.every((item) => item.sourceSha256)).toBe(true);
  });

  it('keeps the archive (and no partial tree) when extraction is refused', async () => {
    const file = join(dir, 'books.zip');
    const zipSize = await makeZip(books(), file);
    // A ceiling smaller than the tree: the worker must refuse before writing it all.
    await open({ ...BUDGET, batchBytes: 8 * KiB, workspaceBytes: 32 * KiB });
    const batch = batches.create({ source: 'zip' });
    const bytes = readFileSync(file);
    batches.zipBegin(batch.id, { name: 'books.zip', size: zipSize });
    batches.zipChunk(batch.id, 0, bytes.toString('base64'));
    await expect(batches.zipFinish(batch.id)).rejects.toThrow();
    const after = lib.importBatches()[0];
    // The verified archive is still there for a retry, the tree is not.
    expect(existsSync(join(batchDir(batch.id), 'source.zip'))).toBe(true);
    expect(readdirSync(batchDir(batch.id)).some((name) => name.endsWith('.extract'))).toBe(false);
    expect(after.zip?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(dirBytes(batch.id)).toBe(zipSize);
  });

  it('refuses a workspace smaller than its own parts', async () => {
    await expect(open({ ...BUDGET, workspaceBytes: 8 * KiB })).rejects.toThrow('workspace budget must cover');
  });

  it('does not leave a partial tree behind when the archive is invalid', async () => {
    const batch = batches.create({ source: 'zip' });
    const garbage = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(512, 3)]);
    batches.zipBegin(batch.id, { name: 'broken.zip', size: garbage.length });
    batches.zipChunk(batch.id, 0, garbage.toString('base64'));
    await expect(batches.zipFinish(batch.id)).rejects.toThrow();
    expect(readdirSync(batchDir(batch.id)).some((name) => name.endsWith('.extract'))).toBe(false);
    expect(existsSync(join(batchDir(batch.id), 'source.zip'))).toBe(true);
  });

  it('can retry the extraction from the stored archive after a restart', async () => {
    const file = join(dir, 'books.zip');
    const zipSize = await makeZip(books(), file);
    const batch = batches.create({ source: 'zip' });
    const bytes = readFileSync(file);
    batches.zipBegin(batch.id, { name: 'books.zip', size: zipSize });
    batches.zipChunk(batch.id, 0, bytes.toString('base64'));
    // Stop before extraction: the batch looks like a crash after a good upload.
    // v1.4 re-verifies on every extraction, so the recovered archive must carry
    // the server digest of the bytes that are actually on disk.
    lib.updateImportBatch(batch.id, (draft) => {
      if (draft.zip) {
        draft.zip.state = 'ready';
        draft.zip.sha256 = createHash('sha256').update(bytes).digest('hex');
      }
    });
    await batches.shutdown();
    lib.close();

    await open();
    const report = batches.resume();
    expect(report.archives).toBeGreaterThanOrEqual(1);
    // Extraction is kicked off again from the verified archive, no re-upload.
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const state = lib.importBatches()[0].zip?.state;
        if (state === 'extracted' || state === 'needs_reselect') { clearInterval(poll); resolve(); return; }
        if (Date.now() - started > 20_000) { clearInterval(poll); reject(new Error('timeout')); }
      }, 50);
    });
    expect(lib.importBatches()[0].zip?.state).toBe('extracted');
    expect(lib.importBatches()[0].items).toHaveLength(3);
  });
});
