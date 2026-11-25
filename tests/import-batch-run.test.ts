import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { ImportBatches } from '../src/import-batches.ts';
import { batchStagingName } from '../src/import-batch.ts';

let dir: string, lib: Library, batches: ImportBatches, time: number;
const now = () => time;

async function waitFor(predicate: () => boolean, label = 'condition', timeout = 40_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function putFile(batchId: string, itemId: string, bytes: Buffer): void {
  batches.stage(batchId, itemId, 0, bytes.toString('base64'));
}

function findItem(batchId: string, name: string) {
  const batch = lib.importBatches().find((row) => row.id === batchId)!;
  return batch.items.find((item) => item.name === name)!;
}

function settled(batchId: string): boolean {
  const batch = lib.importBatches().find((row) => row.id === batchId);
  return !!batch && (batch.status === 'completed' || batch.status === 'cancelled');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-import-batch-'));
  time = Date.parse('2026-10-01T08:00:00Z');
  lib = new Library({ dataDir: dir, now });
  lib.open();
  batches = new ImportBatches(lib, join(dir, 'transfers'), { now });
});
afterEach(async () => {
  await batches.shutdown();
  lib.close();
  rmSync(dir, { recursive: true, force: true });
});

const NOVEL = (title: string) => Buffer.from(`# ${title}\n\n` + '海边的风把鱼吹得很胖。'.repeat(400));

describe('batch import runs the existing single-file pipeline', () => {
  it('imports several files, keeps the shelf order and never queues reading', async () => {
    const batch = batches.create({ source: 'files' });
    batches.addItems(batch.id, [
      { name: '甲.txt', size: NOVEL('甲').length, title: '甲' },
      { name: '乙.txt', size: NOVEL('乙').length, title: '乙' },
      { name: '丙.txt', size: NOVEL('丙').length, title: '丙' },
    ]);
    for (const item of lib.importBatches()[0].items) putFile(batch.id, item.id, NOVEL(item.title));
    const before = lib.list().length;
    batches.start(batch.id);
    await waitFor(() => settled(batch.id), 'batch completion');
    const done = lib.importBatches().find((row) => row.id === batch.id)!;
    expect(done.status).toBe('completed');
    expect(done.items.map((item) => item.status)).toEqual(['completed', 'completed', 'completed']);
    expect(done.items.every((item) => !!item.bookKey)).toBe(true);
    expect(lib.list().length).toBe(before + 3);
    // Importing is not planning: the plan stays empty until the user asks.
    expect(lib.planView().items).toEqual([]);
    expect(lib.status().current).toBeNull();
    // Staging bytes are reclaimed once the item settles.
    for (const item of done.items) expect(existsSync(join(dir, 'transfers', 'batches', batch.id, batchStagingName(item.id)))).toBe(false);
  });

  it('reports an identical revision as a duplicate instead of importing it twice', async () => {
    const text = NOVEL('重复本');
    const first = batches.create({ source: 'files' });
    batches.addItems(first.id, [{ name: '重复本.txt', size: text.length, title: '重复本' }]);
    putFile(first.id, lib.importBatches()[0].items[0].id, text);
    batches.start(first.id);
    await waitFor(() => settled(first.id), 'first import');
    const before = lib.list().length;

    const second = batches.create({ source: 'files' });
    batches.addItems(second.id, [{ name: '重复本.txt', size: text.length, title: '重复本' }]);
    putFile(second.id, lib.importBatches().at(-1)!.items[0].id, text);
    batches.start(second.id);
    await waitFor(() => settled(second.id), 'duplicate import');
    const done = lib.importBatches().at(-1)!;
    expect(done.items[0].status).toBe('completed');
    expect(done.items[0].duplicate).toBe('identical');
    expect(lib.list().length).toBe(before);
  });

  it('surfaces a rejected body as a failed item without stopping the others', async () => {
    const good = NOVEL('好本');
    const batch = batches.create({ source: 'files' });
    batches.addItems(batch.id, [
      { name: '好本.txt', size: good.length, title: '好本' },
      { name: '坏本.txt', size: 64, title: '坏本' },
    ]);
    const items = lib.importBatches()[0].items;
    putFile(batch.id, items[0].id, good);
    putFile(batch.id, items[1].id, Buffer.from('\u0000\u0001 binary garbage \u0002'.padEnd(64, 'x')));
    batches.start(batch.id);
    await waitFor(() => settled(batch.id), 'mixed batch');
    const done = lib.importBatches()[0];
    expect(done.items[0].status).toBe('completed');
    expect(done.items[1].status).toBe('failed');
    expect(done.items[1].error).toBeTruthy();
    expect(done.status).toBe('completed');
  });

  it('cancels one waiting item and keeps importing the rest', async () => {
    const batch = batches.create({ source: 'files' });
    batches.addItems(batch.id, [
      { name: 'a.txt', size: NOVEL('a').length, title: 'a' },
      { name: 'b.txt', size: NOVEL('b').length, title: 'b' },
    ]);
    const items = lib.importBatches()[0].items;
    for (const item of items) putFile(batch.id, item.id, NOVEL(item.title));
    batches.start(batch.id);
    batches.cancelOne(batch.id, items[0].id);
    await waitFor(() => settled(batch.id), 'batch after cancelling one item');
    const done = lib.importBatches()[0];
    expect(done.items.map((item) => item.status).sort()).toEqual(['cancelled', 'completed']);
    // A cancelled item can rejoin the queue and finish from the same staged bytes.
    batches.retry(batch.id, items[0].id);
    await waitFor(() => lib.importBatches()[0].items[0].status === 'completed', 'retried item');
    expect(lib.importBatches()[0].items[0]).toMatchObject({ status: 'completed' });
  });

  it('recovers an interrupted batch after a restart and resumes the item whose bytes survived', async () => {
    const text = NOVEL('重启本');
    const batch = batches.create({ source: 'files' });
    batches.addItems(batch.id, [{ name: '重启本.txt', size: text.length, title: '重启本' }]);
    const item = lib.importBatches()[0].items[0];
    putFile(batch.id, item.id, text);
    // Simulate a process death in the middle of parsing.
    lib.updateImportBatch(batch.id, (draft) => {
      draft.status = 'running';
      draft.items[0].status = 'processing';
      draft.items[0].attempts = 1;
    });
    await batches.shutdown();
    lib.close();

    lib = new Library({ dataDir: dir, now });
    lib.open();
    batches = new ImportBatches(lib, join(dir, 'transfers'), { now });
    const report = batches.resume();
    expect(report).toEqual({ resumed: 1, reselect: 0 });
    await waitFor(() => settled(batch.id), 'resumed batch');
    const done = lib.importBatches()[0];
    expect(done.items[0].status).toBe('completed');
    expect(lib.list()).toHaveLength(1);
  });

  it('marks an interrupted batch for reselect when the staged bytes are gone', async () => {
    const text = NOVEL('丢字节');
    const batch = batches.create({ source: 'files' });
    batches.addItems(batch.id, [{ name: '丢字节.txt', size: text.length, title: '丢字节' }]);
    const item = lib.importBatches()[0].items[0];
    putFile(batch.id, item.id, text);
    lib.updateImportBatch(batch.id, (draft) => {
      draft.status = 'running';
      draft.items[0].status = 'validating';
    });
    unlinkSync(join(dir, 'transfers', 'batches', batch.id, batchStagingName(item.id)));
    await batches.shutdown();
    lib.close();

    lib = new Library({ dataDir: dir, now });
    lib.open();
    batches = new ImportBatches(lib, join(dir, 'transfers'), { now });
    expect(batches.resume()).toEqual({ resumed: 0, reselect: 1 });
    const done = lib.importBatches()[0];
    expect(done.items[0].status).toBe('needs_reselect');
    expect(done.items[0].error).toContain('重新选择');
    expect(done.items[0].attempts).toBe(0);
  });
});

describe('a folder or ZIP keeps the internal structure for grouping', () => {
  it('previews a folder split and refuses to auto-merge the parts', () => {
    const batch = batches.create({ source: 'folder' });
    batches.addItems(batch.id, [
      { name: '长篇小说/1.txt', size: 10, title: '长篇小说' },
      { name: '长篇小说/2.txt', size: 10, title: '长篇小说' },
      { name: '长篇小说/3.txt', size: 10, title: '长篇小说' },
    ]);
    const preview = batches.status(batch.id);
    expect(preview.count).toBe(3);
    expect(preview.groups).toHaveLength(1);
    expect(preview.groups[0]).toMatchObject({ mayBeSplitNovel: true, ambiguous: true });
    // Nothing was merged into the plan; the proposal is only a proposal.
    expect(lib.planView().items).toEqual([]);
  });

  it('imports the supported entries of a ZIP and reports the rest', async () => {
    const yazl = await import('yazl');
    const zipPath = join(dir, 'books.zip');
    const zip = new yazl.ZipFile();
    zip.addBuffer(NOVEL('卷一'), '系列/01 第一部.txt');
    zip.addBuffer(NOVEL('卷二'), '系列/02 第二部.txt');
    zip.addBuffer(Buffer.from('not a novel'), '系列/cover.jpg');
    zip.addBuffer(Buffer.from('hidden'), '__MACOSX/._01.txt');
    zip.end();
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(zipPath);
      out.on('close', () => resolve()).on('error', reject);
      zip.outputStream.pipe(out);
    });

    const batch = batches.create({ source: 'zip' });
    batches.zipBegin(batch.id, { name: 'books.zip', size: statSync(zipPath).size });
    const bytes = readFileSync(zipPath);
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      batches.zipChunk(batch.id, offset, bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.length)).toString('base64'));
    }
    const added = await batches.zipFinish(batch.id);
    expect(added.added.map((item) => item.name)).toEqual(['系列/01 第一部.txt', '系列/02 第二部.txt']);
    expect(added.unsupported).toEqual(['系列/cover.jpg']);
    const preview = batches.status(batch.id);
    expect(preview.count).toBe(2);
    batches.start(batch.id);
    await waitFor(() => settled(batch.id), 'zip batch');
    const done = lib.importBatches()[0];
    expect(done.items.map((item) => item.status)).toEqual(['completed', 'completed']);
    // The title comes from the entry name, exactly like a one-file import.
    expect(lib.list().map((book) => book.title).sort()).toEqual(['01 第一部', '02 第二部']);
  });
});

describe('the plan hand-off stays an explicit second step', () => {
  it('adds completed books to the plan only when asked, and groups them on request', async () => {
    const batch = batches.create({ source: 'folder' });
    batches.addItems(batch.id, [
      { name: '三部曲/01 第一部.txt', size: NOVEL('第一部').length, title: '三部曲 第一部' },
      { name: '三部曲/02 第二部.txt', size: NOVEL('第二部').length, title: '三部曲 第二部' },
    ]);
    for (const item of lib.importBatches()[0].items) putFile(batch.id, item.id, NOVEL(item.title.replace('三部曲 ', '')));
    batches.start(batch.id);
    await waitFor(() => settled(batch.id), 'batch before planning');
    expect(lib.planView().items).toEqual([]);

    const keys = lib.importBatches()[0].items.map((item) => item.bookKey!);
    const result = batches.applyToPlan(batch.id, [{ name: '三部曲', bookKeys: keys }]);
    expect(result.added).toBe(true);
    expect(lib.planView().items.map((item) => item.bookKey).sort()).toEqual([...keys].sort());
    expect(lib.planView().series.map((group) => group.name)).toEqual(['三部曲']);
    expect(lib.planView().series[0].count).toBe(2);
  });

  it('refuses to plan a batch that imported nothing', () => {
    const batch = batches.create({ source: 'files' });
    batches.addItems(batch.id, [{ name: 'a.txt', size: 8, title: 'a' }]);
    expect(batches.applyToPlan(batch.id)).toMatchObject({ added: false, bookKeys: [] });
  });
});
