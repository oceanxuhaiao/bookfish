import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { ImportBatches, sha256File } from '../src/import-batches.ts';
import { batchStagingName } from '../src/import-batch.ts';

let dir: string, lib: Library, batches: ImportBatches, time: number;
const now = () => time;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-batch-identity-'));
  time = Date.parse('2026-10-12T08:00:00Z');
  lib = new Library({ dataDir: dir, now });
  lib.open();
  batches = new ImportBatches(lib, join(dir, 'transfers'), { now });
});
afterEach(async () => {
  await batches.shutdown();
  try { lib.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

const BOOK = (title: string) => Buffer.from(`# ${title}\n\n` + 'the sea is wide. '.repeat(24));
const stagedPath = (batchId: string, itemId: string) => join(dir, 'transfers', 'batches', batchId, batchStagingName(itemId));
const itemAt = (index = -1) => lib.importBatches().at(index)!.items[0];

/** Create a batch with one item and upload the given bytes in one chunk. */
function upload(name: string, body: Buffer) {
  const batch = batches.create({ source: 'files' });
  batches.addItems(batch.id, [{ name, size: body.length }]);
  const item = itemAt();
  batches.stage(batch.id, item.id, 0, body.toString('base64'));
  return { batchId: batch.id, itemId: item.id };
}

/** Put an item into the state a lost staging file produces. */
function loseBytes(batchId: string, itemId: string) {
  rmSync(stagedPath(batchId, itemId), { force: true });
  lib.updateImportBatch(batchId, (draft) => { draft.items[0].status = 'needs_reselect'; draft.items[0].staged = undefined; });
}

describe('a re-picked file must be the same file, proven by content', () => {
  it('records the digest of the accepted upload', () => {
    const body = BOOK('甲');
    const { batchId, itemId } = upload('甲.txt', body);
    const item = itemAt();
    expect(item.id).toBe(itemId);
    expect(item.sourceSha256).toBe(sha(body));
    expect(item.sourceName).toBe('甲.txt');
    expect(batchId).toBeTruthy();
  });

  it('refuses a same-size file with different content', () => {
    const body = BOOK('甲');
    const { batchId, itemId } = upload('甲.txt', body);
    loseBytes(batchId, itemId);
    // Same length, different bytes: the classic mix-up this rule exists for.
    const impostor = Buffer.from(body);
    impostor[impostor.length - 1] = impostor[impostor.length - 1] ^ 0xff;
    expect(impostor.length).toBe(body.length);
    expect(() => batches.reselect(batchId, itemId, { size: impostor.length, name: '甲.txt' })).not.toThrow();
    expect(() => batches.stage(batchId, itemId, 0, impostor.toString('base64'))).toThrow('content differs');
    expect(itemAt().status).toBe('needs_reselect');
    expect(itemAt().sourceSha256).toBe(sha(body));
    expect(existsSync(stagedPath(batchId, itemId))).toBe(false);
    expect(lib.list()).toEqual([]);
  });

  it('refuses a different file name before any byte is uploaded', () => {
    const body = BOOK('甲');
    const { batchId, itemId } = upload('甲.txt', body);
    loseBytes(batchId, itemId);
    expect(() => batches.reselect(batchId, itemId, { size: body.length, name: '乙.txt' })).toThrow('expects “甲.txt”');
    // A folder entry keeps its relative path, so the whole path has to match.
    expect(() => batches.reselect(batchId, itemId, { size: body.length, name: '别的目录/甲.txt' })).toThrow();
  });

  it('accepts the original file again and keeps the item id and the order', () => {
    const body = BOOK('甲');
    const { batchId, itemId } = upload('甲.txt', body);
    loseBytes(batchId, itemId);
    batches.reselect(batchId, itemId, { size: body.length, name: '甲.txt' });
    expect(batches.stage(batchId, itemId, 0, body.toString('base64'))).toMatchObject({ complete: true, sha256: sha(body) });
    expect(itemAt().id).toBe(itemId);
    // Restoring reopens the batch, so the entry may already be parsing again.
    expect(['pending', 'processing', 'completed']).toContain(itemAt().status);
    expect(lib.importBatches()).toHaveLength(1);
  });

  it('lets a failed re-upload be attempted again', () => {
    const body = BOOK('甲');
    const { batchId, itemId } = upload('甲.txt', body);
    loseBytes(batchId, itemId);
    // First attempt dies half way through.
    batches.reselect(batchId, itemId, { size: body.length, name: '甲.txt' });
    batches.stage(batchId, itemId, 0, body.subarray(0, 10).toString('base64'));
    rmSync(stagedPath(batchId, itemId), { force: true });
    lib.updateImportBatch(batchId, (draft) => { draft.items[0].status = 'needs_reselect'; });
    // Second attempt succeeds with the same bytes.
    batches.reselect(batchId, itemId, { size: body.length, name: '甲.txt' });
    expect(batches.stage(batchId, itemId, 0, body.toString('base64'))).toMatchObject({ complete: true });
    expect(itemAt().sourceSha256).toBe(sha(body));
  });

  it('refuses to guess for an entry that never recorded a digest', () => {
    const body = BOOK('甲');
    const { batchId, itemId } = upload('甲.txt', body);
    // Simulate an entry written before content verification existed.
    lib.updateImportBatch(batchId, (draft) => { draft.items[0].status = 'needs_reselect'; delete draft.items[0].sourceSha256; });
    expect(() => batches.reselect(batchId, itemId, { size: body.length, name: '甲.txt' })).toThrow('before content verification');
    // The record is untouched: nothing was deleted or silently replaced.
    expect(itemAt().status).toBe('needs_reselect');
    expect(itemAt().size).toBe(body.length);
    expect(lib.list()).toEqual([]);
  });

  it('re-checks the bytes right before the parser runs', () => {
    const body = BOOK('甲');
    const { batchId, itemId } = upload('甲.txt', body);
    // Somebody swapped the staging file after the upload was accepted.
    const impostor = Buffer.from(body);
    for (let index = 0; index < impostor.length; index += 7) impostor[index] = 0x41;
    writeFileSync(stagedPath(batchId, itemId), impostor);
    batches.start(batchId);
    return new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const item = itemAt();
        if (item.status === 'needs_reselect' || item.status === 'failed') { clearInterval(poll); resolve(); return; }
        if (Date.now() - started > 20_000) { clearInterval(poll); reject(new Error('timeout')); }
      }, 40);
    }).then(() => {
      expect(itemAt().status).toBe('needs_reselect');
      expect(lib.list()).toEqual([]);
    });
  });

  it('hashes files in bounded memory', () => {
    const file = join(dir, 'big.bin');
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const fd = createWriteStream(file);
    for (let index = 0; index < 3; index++) fd.write(chunk);
    fd.end();
    return new Promise<void>((resolve) => fd.on('close', resolve)).then(() => {
      expect(statSync(file).size).toBe(3 * 1024 * 1024);
      expect(sha256File(file)).toBe(sha(Buffer.concat([chunk, chunk, chunk])));
    });
  });
});

describe('archive uploads carry the same identity', () => {
  const zipBody = (padding: number) => Buffer.concat([Buffer.from('PK\u0003\u0004not-a-real-archive'), Buffer.alloc(padding, 9)]);

  it('refuses a body longer than the declared size', () => {
    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'a.zip', size: 16 });
    expect(() => batches.zipChunk(batch.id, 0, zipBody(8).toString('base64'))).toThrow('declared 16 bytes');
  });

  it('refuses to finish a truncated archive', async () => {
    const body = zipBody(64);
    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'a.zip', size: body.length });
    batches.zipChunk(batch.id, 0, body.subarray(0, 10).toString('base64'));
    await expect(batches.zipFinish(batch.id)).rejects.toThrow(/incomplete: declared .* received 10/u);
  });

  it('refuses an archive whose content does not match the claimed digest', async () => {
    const body = zipBody(64);
    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'a.zip', size: body.length, sha256: sha(Buffer.from('something else')) });
    batches.zipChunk(batch.id, 0, body.toString('base64'));
    await expect(batches.zipFinish(batch.id)).rejects.toThrow('does not match the selected file');
    expect(lib.importBatches()[0].zip!.state).toBe('needs_reselect');
  });

  it('persists the verified digest and keeps the archive when extraction fails', async () => {
    const body = zipBody(64);
    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'a.zip', size: body.length });
    batches.zipChunk(batch.id, 0, body.toString('base64'));
    await expect(batches.zipFinish(batch.id)).rejects.toThrow();
    const after = lib.importBatches()[0];
    expect(after.zip).toMatchObject({ size: body.length, sha256: sha(body), state: 'ready' });
    // The archive is still on disk, so a retry needs no new upload.
    expect(existsSync(join(dir, 'transfers', 'batches', batch.id, 'source.zip'))).toBe(true);
  });

  it('refuses a re-uploaded archive of the same length but different content', async () => {
    const body = zipBody(64);
    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'a.zip', size: body.length });
    batches.zipChunk(batch.id, 0, body.toString('base64'));
    await expect(batches.zipFinish(batch.id)).rejects.toThrow();
    expect(lib.importBatches()[0].zip!.sha256).toBe(sha(body));

    const reopened = batches.zipReselect(batch.id);
    expect(reopened).toMatchObject({ batchId: batch.id, size: body.length, sha256: sha(body) });
    const impostor = Buffer.from(body);
    impostor[impostor.length - 1] = 0;
    batches.zipChunk(batch.id, 0, impostor.toString('base64'));
    await expect(batches.zipFinish(batch.id)).rejects.toThrow('same length but different content');
    expect(lib.importBatches()[0].zip!.state).toBe('needs_reselect');
  });

  it('reports an interrupted archive upload after a restart and can reopen the same batch', () => {
    const body = zipBody(64);
    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'a.zip', size: body.length });
    batches.zipChunk(batch.id, 0, body.subarray(0, 20).toString('base64'));
    const partial = join(dir, 'transfers', 'batches', batch.id, 'source.zip');
    expect(statSync(partial).size).toBe(20);

    const report = batches.resume();
    expect(report.archives).toBeGreaterThanOrEqual(1);
    expect(lib.importBatches()[0].zip!.state).toBe('needs_reselect');
    expect(existsSync(partial)).toBe(false);

    const reopened = batches.zipReselect(batch.id);
    expect(reopened).toMatchObject({ batchId: batch.id, size: body.length, sha256: null });
  });

  it('never deletes an archive that has not been extracted yet', () => {
    const body = zipBody(64);
    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'a.zip', size: body.length });
    batches.zipChunk(batch.id, 0, body.toString('base64'));
    lib.updateImportBatch(batch.id, (draft) => { if (draft.zip) draft.zip.state = 'ready'; });
    batches.cleanStale();
    expect(readdirSync(join(dir, 'transfers', 'batches', batch.id))).toContain('source.zip');
  });
});
