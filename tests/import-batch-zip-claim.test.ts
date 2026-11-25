import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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

beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'bookfish-zip-claim-')); time = Date.parse('2026-10-13T08:00:00Z'); await open(); });
afterEach(async () => { await batches.shutdown(); try { lib.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

const batchDir = (id: string) => join(dir, 'transfers', 'batches', id);
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
const books = (): [string, Buffer][] => [
  ['甲.txt', body('甲')],
  ['乙.txt', body('乙')],
];

function uploadBytes(batchId: string, bytes: Buffer) {
  batches.zipBegin(batchId, { name: 'books.zip', size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += 8 * KiB) {
    batches.zipChunk(batchId, offset, bytes.subarray(offset, offset + 8 * KiB).toString('base64'));
  }
}

describe('a claimed digest is an identity constraint that survives refusals', () => {
  it('a wrong claim is refused AND kept, so a same-size impostor cannot retry its way in', async () => {
    const file = join(dir, 'books.zip');
    const good = await makeZip(books(), file);
    const batch = batches.create({ source: 'zip' });

    // The client claims a digest of a DIFFERENT archive, then uploads this one.
    const wrongClaim = sha(Buffer.from('a different archive'));
    batches.zipBegin(batch.id, { name: 'books.zip', size: good.length, sha256: wrongClaim });
    for (let offset = 0; offset < good.length; offset += 8 * KiB) {
      batches.zipChunk(batch.id, offset, good.subarray(offset, offset + 8 * KiB).toString('base64'));
    }
    await expect(batches.zipFinish(batch.id)).rejects.toThrow('does not match the selected file');
    const refused = lib.importBatches()[0];
    expect(refused.zip?.state).toBe('needs_reselect');
    // The claim is NOT deleted: it stays pinned as the identity this batch demands.
    expect(refused.zip?.claimedSha256).toBe(wrongClaim);

    // The user picks the archive the claim describes and re-uploads it. The
    // re-pick is prepared first (nothing changes), then confirmed by begin.
    const prepared = batches.zipReselect(batch.id);
    expect(prepared).toMatchObject({ sha256: wrongClaim });
    // A replacement without the prepared token is refused outright.
    expect(() => batches.zipBegin(batch.id, { name: 'books.zip', size: good.length }))
      .toThrow('re-picked first');
    // The re-begin may not silently drop the pinned claim either.
    batches.zipBegin(batch.id, { name: 'books.zip', size: good.length, token: prepared.token });
    expect(lib.importBatches()[0].zip?.claimedSha256).toBe(wrongClaim);
    // Uploading the SAME wrong archive again is still refused — deleting the
    // claim on mismatch would have let any same-size file in by now.
    for (let offset = 0; offset < good.length; offset += 8 * KiB) {
      batches.zipChunk(batch.id, offset, good.subarray(offset, offset + 8 * KiB).toString('base64'));
    }
    await expect(batches.zipFinish(batch.id)).rejects.toThrow('does not match the selected file');
    expect(lib.importBatches()[0].zip?.claimedSha256).toBe(wrongClaim);
  });

  it('the archive the claim describes is accepted on the re-pick', async () => {
    const file = join(dir, 'books.zip');
    const good = await makeZip(books(), file);
    const batch = batches.create({ source: 'zip' });
    const claim = sha(good);

    // Interrupted first upload with the claim already pinned.
    batches.zipBegin(batch.id, { name: 'books.zip', size: good.length, sha256: claim });
    batches.zipChunk(batch.id, 0, good.subarray(0, 8 * KiB).toString('base64'));
    batches.resume(); // drops the partial file, marks needs_reselect

    const reopened = batches.zipReselect(batch.id);
    expect(reopened).toMatchObject({ sha256: claim });
    expect(batches.status(batch.id).zip?.reselectable).toBe(true);
    // Re-upload the exact archive: accepted, verified against the claim, extracted.
    batches.zipBegin(batch.id, { name: 'books.zip', size: good.length, sha256: claim, token: reopened.token });
    for (let offset = 0; offset < good.length; offset += 8 * KiB) {
      batches.zipChunk(batch.id, offset, good.subarray(offset, offset + 8 * KiB).toString('base64'));
    }
    await expect(batches.zipFinish(batch.id)).resolves.toBeTruthy();
    const after = lib.importBatches()[0];
    expect(after.zip?.state).toBe('extracted');
    expect(after.zip?.sha256).toBe(claim);
    expect(after.items).toHaveLength(2);
  });

  it('a re-begin cannot swap the pinned digest for a different one', async () => {
    const file = join(dir, 'books.zip');
    const good = await makeZip(books(), file);
    const batch = batches.create({ source: 'zip' });
    const claim = sha(good);
    batches.zipBegin(batch.id, { name: 'books.zip', size: good.length, sha256: claim });
    batches.zipChunk(batch.id, 0, good.subarray(0, 8 * KiB).toString('base64'));
    batches.resume();
    const prepared = batches.zipReselect(batch.id);
    // Same length, a DIFFERENT claimed digest: swapping identities is refused.
    expect(() => batches.zipBegin(batch.id, { name: 'books.zip', size: good.length, sha256: sha(Buffer.from('other')), token: prepared.token }))
      .toThrow('内容指纹不一致');
    // The rejected begin changed nothing: the claim is still pinned and the batch
    // is still waiting for the original archive.
    expect(lib.importBatches()[0].zip?.claimedSha256).toBe(claim);
    expect(lib.importBatches()[0].zip?.state).toBe('needs_reselect');
  });
});
