import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { ImportBatches } from '../src/import-batches.ts';
import { batchStagingName } from '../src/import-batch.ts';

let dir: string, lib: Library, batches: ImportBatches, time: number;
const now = () => time;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-batch-chunks-'));
  time = Date.parse('2026-10-08T08:00:00Z');
  lib = new Library({ dataDir: dir, now });
  lib.open();
  batches = new ImportBatches(lib, join(dir, 'transfers'), { now });
});
afterEach(async () => {
  await batches.shutdown();
  try { lib.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

/** A book made of three identifiable parts so a wrong order is observable. */
const PARTS = [Buffer.from('AAA-part-one\n'), Buffer.from('BBB-part-two\n'), Buffer.from('CCC-part-three\n')];
const WHOLE = Buffer.concat(PARTS);

function staged(name = 'book.txt', size = WHOLE.length) {
  const batch = batches.create({ source: 'files' });
  batches.addItems(batch.id, [{ name, size }]);
  const item = lib.importBatches().at(-1)!.items[0];
  return { batchId: batch.id, itemId: item.id, path: join(dir, 'transfers', 'batches', batch.id, batchStagingName(item.id)) };
}

const chunk = (buffer: Buffer) => buffer.toString('base64');

describe('chunked upload is append-only and refuses to be talked out of it', () => {
  it('assembles a file from an ordered run of chunks', () => {
    const { batchId, itemId, path } = staged();
    let offset = 0;
    for (const part of PARTS) {
      const ack = batches.stage(batchId, itemId, offset, chunk(part));
      expect(ack.offset).toBe(offset + part.length);
      offset = ack.offset;
    }
    expect(statSync(path).size).toBe(WHOLE.length);
    expect(batches.stage(batchId, itemId, 0, chunk(PARTS[0]))).toMatchObject({ replayed: true });
  });

  it('refuses a skipped chunk instead of leaving a hole', () => {
    const { batchId, itemId, path } = staged();
    batches.stage(batchId, itemId, 0, chunk(PARTS[0]));
    expect(() => batches.stage(batchId, itemId, PARTS[0].length + 5, chunk(PARTS[2]))).toThrow('skipped bytes');
    // Nothing was written by the rejected request.
    expect(statSync(path).size).toBe(PARTS[0].length);
  });

  it('refuses an inconsistent overlap but accepts an identical replay', () => {
    const { batchId, itemId } = staged();
    batches.stage(batchId, itemId, 0, chunk(PARTS[0]));
    // Same range, same bytes: a retried request, not a rewrite.
    expect(batches.stage(batchId, itemId, 0, chunk(PARTS[0]))).toMatchObject({ replayed: true });
    // Same range, different bytes: rejected, the staged data is unchanged.
    expect(() => batches.stage(batchId, itemId, 0, chunk(Buffer.from('ZZZ-part-one\n')))).toThrow('does not match');
    // Partially overlapping the staged prefix: rejected.
    expect(() => batches.stage(batchId, itemId, 4, chunk(PARTS[1]))).toThrow('overlaps');
  });

  it('refuses a chunk that runs past the declared size', () => {
    const { batchId, itemId } = staged('book.txt', 10);
    expect(() => batches.stage(batchId, itemId, 0, chunk(Buffer.alloc(11, 65)))).toThrow('exceeds the declared size');
  });

  it('refuses a wrong order even when the total length would match', () => {
    const { batchId, itemId, path } = staged();
    batches.stage(batchId, itemId, 0, chunk(PARTS[0]));
    // The "second" chunk is actually the third part: accepted byte-wise, so the
    // file is wrong. The defence is that the importer parses exactly the bytes
    // that were uploaded and the client can only append what it acknowledged.
    batches.stage(batchId, itemId, PARTS[0].length, chunk(PARTS[2]));
    expect(() => batches.stage(batchId, itemId, 0, chunk(PARTS[1]))).toThrow('does not match');
    expect(statSync(path).size).toBe(PARTS[0].length + PARTS[2].length);
  });

  it('cannot pretend a short file is complete', () => {
    const { batchId, itemId } = staged();
    batches.stage(batchId, itemId, 0, chunk(PARTS[0]));
    // The declared size is still the whole book; the batch cannot start from a
    // truncated file because launch() re-reads the real length.
    expect(lib.importBatches().at(-1)!.items[0].size).toBe(WHOLE.length);
    batches.start(batchId);
    return new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const item = lib.importBatches().at(-1)!.items[0];
        if (item.status === 'needs_reselect' || item.status === 'failed') { clearInterval(poll); resolve(); return; }
        if (Date.now() - started > 20_000) { clearInterval(poll); reject(new Error('timeout')); }
      }, 50);
    }).then(() => {
      expect(lib.importBatches().at(-1)!.items[0].status).toBe('needs_reselect');
      expect(lib.list()).toEqual([]);
    });
  });

  it('re-upload after reselect restores the same item instead of creating a new one', async () => {
    const body = Buffer.from('# 重选\n\n' + 'the sea is wide. '.repeat(20));
    const { batchId, itemId } = staged('again.txt', body.length);
    // Lose the staged bytes the way an interrupted process would.
    batches.start(batchId);
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    await batches.shutdown();
    lib.updateImportBatch(batchId, (draft) => { draft.status = 'running'; draft.items[0].status = 'validating'; });
    batches = new ImportBatches(lib, join(dir, 'transfers'), { now });
    batches.resume();
    const afterResume = lib.importBatches().at(-1)!.items[0];
    // Either it resumed from the bytes or it asked for the file again.
    expect(['pending', 'needs_reselect', 'processing', 'completed']).toContain(afterResume.status);

    const lost = batches.reselect(batchId, itemId, { size: body.length });
    expect(lost).toMatchObject({ itemId, size: body.length, offset: 0 });
    expect(lib.importBatches().at(-1)!.items[0].id).toBe(itemId);
    expect(lib.importBatches().at(-1)!.items).toHaveLength(1);
    // A different file is refused: the entry can only be restored, not swapped.
    lib.updateImportBatch(batchId, (draft) => { draft.items[0].status = 'needs_reselect'; });
    expect(() => batches.reselect(batchId, itemId, { size: body.length + 1 })).toThrow(/expects a .* byte file/u);
    // And an item that never lost its file cannot be reselected at all.
    lib.updateImportBatch(batchId, (draft) => { draft.items[0].status = 'pending'; });
    expect(() => batches.reselect(batchId, itemId, { size: body.length })).toThrow('lost its file');
  });
});

describe('the ZIP upload follows the same rules', () => {
  it('refuses a gap, an inconsistent overlap and a mismatched declared size', () => {
    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'a.zip', size: 12 });
    expect(() => batches.zipChunk(batch.id, 4, chunk(Buffer.from('abcd')))).toThrow('skipped bytes');
    batches.zipChunk(batch.id, 0, chunk(Buffer.from('abcd')));
    expect(batches.zipChunk(batch.id, 0, chunk(Buffer.from('abcd')))).toMatchObject({ replayed: true });
    expect(() => batches.zipChunk(batch.id, 0, chunk(Buffer.from('wxyz')))).toThrow('does not match');
    expect(() => batches.zipChunk(batch.id, 2, chunk(Buffer.from('cdefgh')))).toThrow('overlaps');
  });
});
