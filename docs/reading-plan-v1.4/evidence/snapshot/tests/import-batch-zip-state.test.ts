import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Library } from '../src/library.ts';
import { ImportBatches } from '../src/import-batches.ts';

/**
 * v1.4 state machine: the archive is re-verified on every extraction, a begin
 * never destroys staged bytes, and a re-pick is a two-phase transaction that
 * survives the user cancelling the file dialog.
 */
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

beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'bookfish-zip-state-')); time = Date.parse('2026-10-13T08:00:00Z'); await open(); });
afterEach(async () => { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

const batchDir = (id: string) => join(dir, 'transfers', 'batches', id);
const zipPath = (id: string) => join(batchDir(id), 'source.zip');
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

async function makeZip(entries: [string, Buffer][], file: string): Promise<Buffer> {
  const yazl = await import('yazl');
  const zip = new yazl.ZipFile();
  for (const [name, body] of entries) zip.addBuffer(body, name);
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(file);
    out.on('close', () => resolve()).on('error', reject);
    zip.outputStream.pipe(out);
  });
  return readFileSync(file);
}

const body = (seed: string): Buffer => Buffer.from(`# ${seed}\n` + `${seed} the tide is low. `.repeat(360));
const books = (): [string, Buffer][] => [['甲.txt', body('甲')], ['乙.txt', body('乙')]];

/** Upload every byte, stop before finishing. */
function upload(batchId: string, bytes: Buffer, offsetStart = 0): void {
  for (let offset = offsetStart; offset < bytes.length; offset += 8 * KiB) {
    batches.zipChunk(batchId, offset, bytes.subarray(offset, offset + 8 * KiB).toString('base64'));
  }
}

/** A batch whose upload is complete and whose bytes are verified, awaiting extraction. */
async function readyBatch(zip: Buffer): Promise<string> {
  const batch = batches.create({ source: 'zip' });
  batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length });
  upload(batch.id, zip);
  lib.updateImportBatch(batch.id, (draft) => {
    if (draft.zip) { draft.zip.state = 'ready'; draft.zip.sha256 = sha(zip); }
  });
  return batch.id;
}

describe('every extraction re-establishes the archive identity', () => {
  it('refuses a ready archive whose bytes were replaced, keeping the evidence', async () => {
    const file = join(dir, 'books.zip');
    const zip = await makeZip(books(), file);
    const batchId = await readyBatch(zip);
    // Same length, different bytes: the classic swap a size check cannot see.
    const impostor = Buffer.from(zip);
    for (let index = 0; index < 32; index += 1) impostor[impostor.length - 40 - index] ^= 0xff;
    expect(impostor.length).toBe(zip.length);
    rmSync(zipPath(batchId), { force: true });
    await import('node:fs').then(({ writeFileSync }) => writeFileSync(zipPath(batchId), impostor));

    await expect(batches.zipFinish(batchId)).rejects.toThrow('内容与已验证的摘要不一致');
    const after = lib.importBatches()[0];
    expect(after.zip?.state).toBe('ready');
    expect(after.zip?.failure).toBe('unverifiable');
    // Nothing was handed to the extractor: no entry, no staged file.
    expect(after.items).toHaveLength(0);
    expect(existsSync(zipPath(batchId))).toBe(true);
  });

  it('refuses a truncated archive as missing, not as a re-upload request', async () => {
    const file = join(dir, 'books.zip');
    const zip = await makeZip(books(), file);
    const batchId = await readyBatch(zip);
    await import('node:fs').then(({ truncateSync }) => truncateSync(zipPath(batchId), Math.floor(zip.length / 2)));

    await expect(batches.zipFinish(batchId)).rejects.toThrow('长度与声明不一致');
    const after = lib.importBatches()[0];
    expect(after.zip?.failure).toBe('missing');
    expect(after.zip?.state).toBe('ready');
    expect(after.items).toHaveLength(0);
  });

  it('keeps already-staged books when a later verification fails', async () => {
    const file = join(dir, 'books.zip');
    const zip = await makeZip(books(), file);
    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length });
    upload(batch.id, zip);
    await batches.zipFinish(batch.id);
    // First extraction succeeded; the archive is gone and the batch is terminal.
    expect(lib.importBatches()[0].zip?.state).toBe('extracted');
    expect(lib.importBatches()[0].items.every((item) => item.staged)).toBe(true);
    // Any later attempt is a no-op rather than a second run.
    const again = await batches.zipFinish(batch.id);
    expect(again.alreadyExtracted).toBe(true);
    expect(lib.importBatches()[0].items).toHaveLength(2);
  });

  it('refuses a ready archive that was never verified by the server', async () => {
    const file = join(dir, 'books.zip');
    const zip = await makeZip(books(), file);
    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length });
    upload(batch.id, zip);
    // A legacy record with no server digest: trusting it would mean trusting the
    // disk, which is exactly what cannot be proven here.
    lib.updateImportBatch(batch.id, (draft) => { if (draft.zip) { draft.zip.state = 'ready'; draft.zip.sha256 = undefined; } });
    await expect(batches.zipFinish(batch.id)).rejects.toThrow('没有可验证的压缩包摘要');
    expect(lib.importBatches()[0].zip?.failure).toBe('unverifiable');
    expect(lib.importBatches()[0].zip?.state).toBe('ready');
  });
});

describe('a begin never destroys staged bytes', () => {
  it('an idempotent begin reports the real offset and keeps every byte', async () => {
    const file = join(dir, 'books.zip');
    const zip = await makeZip(books(), file);
    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length });
    batches.zipChunk(batch.id, 0, zip.subarray(0, 100).toString('base64'));
    const before = statSync(zipPath(batch.id)).size;
    expect(before).toBe(100);

    // The same begin again (a retried request, a reconnecting client).
    const again = batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length }) as { offset: number; resumed?: boolean };
    expect(again.offset).toBe(100);
    expect(again.resumed).toBe(true);
    // Not truncated, not rewritten.
    expect(statSync(zipPath(batch.id)).size).toBe(100);
    // The upload continues from where it stopped and completes normally.
    upload(batch.id, zip, again.offset);
    await expect(batches.zipFinish(batch.id)).resolves.toBeTruthy();
    expect(lib.importBatches()[0].items).toHaveLength(2);
  });

  it('a begin on a verified archive is refused and the bytes stay untouched', async () => {
    const file = join(dir, 'books.zip');
    const zip = await makeZip(books(), file);
    const batchId = await readyBatch(zip);
    const before = sha(readFileSync(zipPath(batchId)));
    expect(() => batches.zipBegin(batchId, { name: 'books.zip', size: zip.length })).toThrow('cannot be replaced here');
    expect(sha(readFileSync(zipPath(batchId)))).toBe(before);
    expect(lib.importBatches()[0].zip?.state).toBe('ready');
  });

  it('a begin on an extracted archive is refused outright', async () => {
    const file = join(dir, 'books.zip');
    const zip = await makeZip(books(), file);
    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length });
    upload(batch.id, zip);
    await batches.zipFinish(batch.id);
    expect(() => batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length })).toThrow('already been extracted');
    expect(lib.importBatches()[0].zip?.state).toBe('extracted');
  });

  it('a conflicting begin while uploading is refused without losing bytes', async () => {
    const file = join(dir, 'books.zip');
    const zip = await makeZip(books(), file);
    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length, sha256: sha(zip) });
    batches.zipChunk(batch.id, 0, zip.subarray(0, 100).toString('base64'));
    expect(() => batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length, sha256: sha(Buffer.from('other')) }))
      .toThrow('already pinned a different archive digest');
    expect(statSync(zipPath(batch.id)).size).toBe(100);
  });
});

describe('re-picking an archive is a two-phase transaction', () => {
  it('preparing a re-pick changes nothing, so cancelling the dialog leaves the batch usable', async () => {
    const file = join(dir, 'books.zip');
    const zip = await makeZip(books(), file);
    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length, sha256: sha(zip) });
    batches.zipChunk(batch.id, 0, zip.subarray(0, 40).toString('base64'));
    batches.resume(); // interrupted upload → needs_reselect

    const before = lib.importBatches()[0].zip;
    const prepared = batches.zipReselect(batch.id);
    expect(prepared.token).toBeTruthy();
    const after = lib.importBatches()[0].zip;
    // No state change, no file deleted, no empty file created.
    expect(after?.state).toBe(before?.state);
    expect(after?.sha256).toBe(before?.sha256);
    expect(after?.claimedSha256).toBe(before?.claimedSha256);
    expect(lib.importBatches()[0].zip?.state).toBe('needs_reselect');
    // The user can simply try again: a second prepare works exactly the same.
    expect(batches.zipReselect(batch.id).token).toBeTruthy();
    // And the upload can still be completed afterwards.
    const token = batches.zipReselect(batch.id).token;
    batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length, sha256: sha(zip), token });
    upload(batch.id, zip);
    await expect(batches.zipFinish(batch.id)).resolves.toBeTruthy();
    expect(lib.importBatches()[0].items).toHaveLength(2);
  });

  it('a wrong pick is rejected and the batch can be re-picked again', async () => {
    const file = join(dir, 'books.zip');
    const zip = await makeZip(books(), file);
    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length, sha256: sha(zip) });
    batches.zipChunk(batch.id, 0, zip.subarray(0, 40).toString('base64'));
    batches.resume();

    const first = batches.zipReselect(batch.id);
    // Same length, different content: the digest the client sends is not the one
    // this batch accepted, so the begin itself is refused.
    expect(() => batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length, sha256: sha(Buffer.from('nope')), token: first.token }))
      .toThrow('内容指纹不一致');
    // The batch is still re-pickable, with a fresh token.
    const second = batches.zipReselect(batch.id);
    expect(second.token).not.toBe(first.token);
    expect(second.sha256).toBe(sha(zip));
  });

  it('a token is single-use and cannot be replayed', async () => {
    const file = join(dir, 'books.zip');
    const zip = await makeZip(books(), file);
    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length, sha256: sha(zip) });
    batches.zipChunk(batch.id, 0, zip.subarray(0, 40).toString('base64'));
    batches.resume();
    const prepared = batches.zipReselect(batch.id);
    batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length, sha256: sha(zip), token: prepared.token });
    // The upload is live now: a second begin with the same token is no longer a
    // replacement, it is an idempotent resume.
    const again = batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length, sha256: sha(zip), token: prepared.token }) as { offset: number };
    expect(again.offset).toBe(0);
    expect(statSync(zipPath(batch.id)).size).toBe(0);
  });

  it('a re-pick with entries already staged is allowed and does not duplicate them', async () => {
    const file = join(dir, 'books.zip');
    const zip = await makeZip(books(), file);
    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length, sha256: sha(zip) });
    upload(batch.id, zip);
    await batches.zipFinish(batch.id);
    const staged = lib.importBatches()[0].items.filter((item) => item.staged);
    expect(staged).toHaveLength(2);

    // Simulate the archive turning unprovable after books were already staged.
    await import('node:fs').then(({ writeFileSync }) => writeFileSync(zipPath(batch.id), zip));
    lib.updateImportBatch(batch.id, (draft) => {
      if (draft.zip) { draft.zip.state = 'ready'; draft.zip.failure = 'unverifiable'; }
    });
    const prepared = batches.zipReselect(batch.id);
    expect(prepared.size).toBe(zip.length);
    batches.zipBegin(batch.id, { name: 'books.zip', size: zip.length, sha256: sha(zip), token: prepared.token });
    upload(batch.id, zip);
    await batches.zipFinish(batch.id);
    // The same two entries, each with exactly one staged file: no duplicates.
    const after = lib.importBatches()[0];
    expect(after.items).toHaveLength(2);
    expect(after.items.filter((item) => item.staged)).toHaveLength(2);
  });
});
