import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { ImportBatches, sha256File } from '../src/import-batches.ts';

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

beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'bookfish-zip-race-')); time = Date.parse('2026-10-13T08:00:00Z'); await open(); });
afterEach(async () => { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

const batchDir = (id: string) => join(dir, 'transfers', 'batches', id);

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
const books = (): [string, Buffer][] => [
  ['甲.txt', body('甲')],
  ['乙.txt', body('乙')],
  ['丙.txt', body('丙')],
];

/**
 * Upload the whole archive but stop before finishing (state stays `uploading`).
 *
 * Begins where the server says the upload actually is: a repeated begin is
 * idempotent since v1.4 and must never truncate bytes that are already staged.
 */
function uploadOnly(batchId: string, file: string): void {
  const bytes = readFileSync(file);
  const info = batches.zipBegin(batchId, { name: 'books.zip', size: bytes.length }) as { offset?: number };
  for (let offset = info.offset ?? 0; offset < bytes.length; offset += 8 * KiB) {
    batches.zipChunk(batchId, offset, bytes.subarray(offset, offset + 8 * KiB).toString('base64'));
  }
}

describe('one extraction per batch, no matter who asks', () => {
  it('two concurrent finishes share one extraction and one result object', async () => {
    const file = join(dir, 'books.zip');
    await makeZip(books(), file);
    const batch = batches.create({ source: 'zip' });
    uploadOnly(batch.id, file);

    // Both callers race: the first promotes the archive to ready and starts the
    // extraction; the second observes the in-flight extraction and joins it.
    const [first, second] = await Promise.all([
      batches.zipFinish(batch.id).catch((error: Error) => error),
      batches.zipFinish(batch.id).catch((error: Error) => error),
    ]);
    expect(first).not.toBeInstanceOf(Error);
    expect(second).not.toBeInstanceOf(Error);
    // The single-flight wrapper hands every caller the very same result object.
    expect(second).toBe(first);
    const after = lib.importBatches()[0];
    expect(after.zip?.state).toBe('extracted');
    // Exactly one set of staging files: no duplicate writes, no overwrite races.
    expect(after.items).toHaveLength(3);
    expect(readdirSync(batchDir(batch.id)).filter((name) => name.endsWith('.src'))).toHaveLength(3);
    expect(existsSync(join(batchDir(batch.id), 'source.zip'))).toBe(false);
  });

  it('a finish after completion reports alreadyExtracted instead of re-extracting', async () => {
    const file = join(dir, 'books.zip');
    await makeZip(books(), file);
    const batch = batches.create({ source: 'zip' });
    uploadOnly(batch.id, file);
    await batches.zipFinish(batch.id);
    const again = await batches.zipFinish(batch.id);
    expect(again.alreadyExtracted).toBe(true);
    expect(again.added).toHaveLength(0);
    const after = lib.importBatches()[0];
    expect(after.zip?.state).toBe('extracted');
    expect(after.items).toHaveLength(3);
  });

  it('an uploading archive cannot be extracted, and chunks are refused once extraction started', async () => {
    const file = join(dir, 'books.zip');
    await makeZip(books(), file);
    const batch = batches.create({ source: 'zip' });
    // The fixture compresses to a few hundred bytes, so "not fully uploaded"
    // must be a strict prefix — a fixed 8 KiB slice would be the whole archive
    // and finish would legitimately succeed. Finish is refused on length, and
    // there is no direct path from `uploading` into extraction.
    const bytes = readFileSync(file);
    batches.zipBegin(batch.id, { name: 'books.zip', size: bytes.length });
    batches.zipChunk(batch.id, 0, bytes.subarray(0, Math.floor(bytes.length / 2)).toString('base64'));
    await expect(batches.zipFinish(batch.id)).rejects.toThrow('incomplete');

    uploadOnly(batch.id, file);
    const flight = batches.zipFinish(batch.id);
    // While the extraction is in flight (or done), the archive is not accepting
    // data: state is `ready`/`extracted`, never `uploading`.
    await expect(flight).resolves.toBeTruthy();
    expect(() => batches.zipChunk(batch.id, 0, 'AAAA')).toThrow('not accepting data');
    expect(() => batches.zipReselect(batch.id)).toThrow();
  });
});

describe('recovery extraction is serialized across batches', () => {
  it('runs ready archives one at a time, never in parallel', async () => {
    const file = join(dir, 'books.zip');
    const zipSize = await makeZip(books(), file);
    const ids: string[] = [];
    // v1.4 re-verifies the archive on every extraction, so a synthetic `ready`
    // must carry the digest the bytes actually have — an unprovable archive is
    // refused instead of trusted.
    const digest = sha256File(file);
    for (let index = 0; index < 3; index += 1) {
      const batch = batches.create({ source: 'zip' });
      uploadOnly(batch.id, file);
      // A crash after a good upload: verified bytes, no extraction yet.
      lib.updateImportBatch(batch.id, (draft) => {
        if (draft.zip) { draft.zip.state = 'ready'; draft.zip.sha256 = digest; }
      });
      ids.push(batch.id);
    }
    void zipSize;

    const real = batches.importZip.bind(batches);
    let active = 0;
    let peak = 0;
    const spy = vi.spyOn(batches, 'importZip').mockImplementation(async (id: string, path: string, signal?: AbortSignal) => {
      active += 1;
      peak = Math.max(peak, active);
      try { return await real(id, path, signal); } finally { active -= 1; }
    });

    const report = batches.resume();
    expect(report.archives).toBe(3);
    // The recovery chain is awaited via polling: all three must finish.
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const rows = lib.importBatches();
        const done = rows.every((row) => row.zip?.state === 'extracted' || row.zip?.state === 'needs_reselect');
        if (done) { clearInterval(poll); resolve(); return; }
        if (Date.now() - started > 30_000) { clearInterval(poll); reject(new Error('timeout')); }
      }, 50);
    });
    expect(spy).toHaveBeenCalledTimes(3);
    // Serialized by design: at most one extraction in flight at any moment.
    expect(peak).toBe(1);
    for (const row of lib.importBatches()) {
      expect(row.zip?.state).toBe('extracted');
      expect(row.items).toHaveLength(3);
    }
  });
});
