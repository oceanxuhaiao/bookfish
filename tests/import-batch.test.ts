import { describe, expect, it } from 'vitest';
import {
  BATCH_ATTEMPT_LIMIT, BATCH_CONCURRENCY, BATCH_ITEM_LIMIT, addBatchItems, batchSummary, beginBatch,
  cancelBatch, cancelItem, completedBookKeys, dispatchable, hintDuplicate, isSupportedNovel,
  markInBatchDuplicates, newBatch, previewBatch, reconcileBatch, retryItem, runningCount, safeBatchName,
  setItemStatus, titleAuthorId, trimBatches, validateBatches, type BatchItemInput, type ImportBatch,
} from '../src/import-batch.ts';

const NOW = Date.parse('2026-10-01T08:00:00Z');
const B = '11111111-2222-3333-4444-555555555555';
const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

function batchOf(names: [string, string][], source: 'files' | 'folder' | 'zip' = 'files'): ImportBatch {
  const batch = newBatch({ id: B, source }, NOW);
  addBatchItems(batch, names.map(([name, title], index) => ({ id: uuid(index + 1), name, size: 1024, title })), NOW);
  return batch;
}

describe('batch import state machine', () => {
  it('accepts files, a folder listing and ZIP entries through the same item list', () => {
    const files = batchOf([['a.txt', 'A'], ['b.md', 'B']]);
    const folder = batchOf([['系列/01.txt', '系列 第一部'], ['系列/02.txt', '系列 第二部']], 'folder');
    const zip = batchOf([['合集/x.txt', 'X'], ['合集/y.txt', 'Y']], 'zip');
    expect(files.items.map((item) => item.name)).toEqual(['a.txt', 'b.md']);
    expect(folder.items.map((item) => item.name)).toEqual(['系列/01.txt', '系列/02.txt']);
    expect(zip.source).toBe('zip');
    expect(folder.items.every((item) => item.supported)).toBe(true);
  });

  it('drops duplicate paths, unsupported extensions and overflow explicitly', () => {
    const batch = batchOf([['a.txt', 'A']]);
    const result = addBatchItems(batch, [
      { id: uuid(9), name: 'A.TXT', size: 10, title: 'A again' },
      { id: uuid(10), name: 'cover.jpg', size: 10, title: 'Cover' },
      { id: uuid(11), name: '../escape.txt', size: 10, title: 'Escape' },
    ], NOW);
    expect(result.added).toEqual([]);
    expect(result.duplicates).toEqual(['A.TXT', '../escape.txt']);
    expect(result.unsupported).toEqual(['cover.jpg']);
    const many = Array.from({ length: BATCH_ITEM_LIMIT + 2 }, (_, index) => ({ id: uuid(200 + index), name: `n${index}.txt`, size: 10, title: `N${index}` }));
    expect(addBatchItems(batch, many, NOW).overflow).toBeGreaterThan(0);
    expect(batch.items.length).toBeLessThanOrEqual(BATCH_ITEM_LIMIT);
  });

  it('refuses path traversal and control characters in a picked name', () => {
    expect(() => safeBatchName('../../etc/passwd')).toThrow();
    expect(() => safeBatchName('a\u0000b.txt')).toThrow();
    expect(safeBatchName('系列\\第一部.txt')).toBe('系列/第一部.txt');
    expect(isSupportedNovel('a.EPUB')).toBe(true);
    expect(isSupportedNovel('a.docx')).toBe(false);
  });

  it('runs at most the concurrency limit and never exceeds the attempt budget', () => {
    const batch = batchOf(Array.from({ length: 5 }, (_, index) => [`n${index}.txt`, `N${index}`] as [string, string]));
    beginBatch(batch, NOW);
    expect(dispatchable(batch, 0)).toHaveLength(BATCH_CONCURRENCY);
    expect(dispatchable(batch, BATCH_CONCURRENCY)).toHaveLength(0);
    expect(dispatchable(batch, 1)).toHaveLength(1);
    const first = batch.items[0];
    first.attempts = BATCH_ATTEMPT_LIMIT;
    expect(dispatchable(batch, 0).map((item) => item.id)).not.toContain(first.id);
    // A batch that is not running dispatches nothing at all.
    cancelBatch(batch, NOW);
    expect(dispatchable(batch, 0)).toHaveLength(0);
  });

  it('reports progress and settles only when nothing can still run', () => {
    const batch = batchOf([['a.txt', 'A'], ['b.txt', 'B']]);
    beginBatch(batch, NOW);
    setItemStatus(batch, batch.items[0].id, 'processing', {}, NOW + 1);
    expect(runningCount(batch)).toBe(1);
    setItemStatus(batch, batch.items[0].id, 'completed', { bookKey: 'a:1' }, NOW + 2);
    expect(batch.status).toBe('running');
    setItemStatus(batch, batch.items[1].id, 'completed', { bookKey: 'b:1' }, NOW + 3);
    expect(batch.status).toBe('completed');
    expect(completedBookKeys(batch)).toEqual(['a:1', 'b:1']);
    expect(batchSummary(batch)).toMatchObject({ total: 2, completed: 2, failed: 0, pending: 0 });
  });

  it('cancels the whole batch and one item without losing the rest', () => {
    const all = batchOf([['a.txt', 'A'], ['b.txt', 'B']]);
    beginBatch(all, NOW);
    cancelBatch(all, NOW + 1);
    expect(all.status).toBe('cancelled');
    expect(all.items.every((item) => item.status === 'cancelled')).toBe(true);

    const one = batchOf([['a.txt', 'A'], ['b.txt', 'B']]);
    beginBatch(one, NOW);
    expect(cancelItem(one, one.items[0].id, NOW + 1)).toBe(false);
    expect(one.items[0].status).toBe('cancelled');
    expect(one.status).toBe('running');
    // A cancelled item can be retried and rejoins the queue.
    expect(retryItem(one, one.items[0].id, NOW + 2).status).toBe('pending');
    expect(one.items[0].attempts).toBe(0);
  });

  it('marks an interrupted item for reselect only when its bytes are gone', () => {
    const batch = batchOf([['a.txt', 'A'], ['b.txt', 'B']]);
    beginBatch(batch, NOW);
    for (const item of batch.items) { item.status = 'processing'; item.staged = item.id + '.src'; }
    const report = reconcileBatch(batch, (item) => item.name === 'a.txt' ? 1024 : null, NOW + 5);
    expect(report.resumed).toEqual([batch.items[0].id]);
    expect(report.reselect).toEqual([batch.items[1].id]);
    expect(batch.items[0].status).toBe('pending');
    expect(batch.items[1].status).toBe('needs_reselect');
    expect(batch.status).toBe('running');
  });

  it('surfaces a truncated staged file as needs_reselect too', () => {
    const batch = batchOf([['a.txt', 'A']]);
    beginBatch(batch, NOW);
    batch.items[0].status = 'validating';
    const report = reconcileBatch(batch, () => 10, NOW + 1);
    expect(report.reselect).toHaveLength(1);
    expect(batch.items[0].error).toContain('重新选择');
  });
});

describe('batch preview', () => {
  it('lists count, size, unsupported files and the plan hand-off flag', () => {
    const batch = batchOf([
      ['系列/01 第一部.txt', '系列 第一部'],
      ['系列/02 第二部.txt', '系列 第二部'],
      ['note.txt', 'Note'],
    ], 'folder');
    const preview = previewBatch(batch, []);
    expect(preview.count).toBe(3);
    expect(preview.supported).toBe(3);
    expect(preview.estimatedBytes).toBe(3 * 1024);
    expect(preview.toPlan).toBe(false);
    expect(preview.groups.map((group) => [group.evidence, group.itemIds.length, group.mayBeSplitNovel])).toEqual([['folder', 2, false]]);
  });

  it('never merges a possible split novel: it flags the group as ambiguous', () => {
    const batch = batchOf([['书/1.txt', '同一本书'], ['书/2.txt', '同一本书']], 'folder');
    const [group] = previewBatch(batch, []).groups;
    expect(group.itemIds).toHaveLength(2);
    expect(group.mayBeSplitNovel).toBe(true);
    expect(group.ambiguous).toBe(true);
  });

  it('matches an existing revision by title and author without claiming a body match', () => {
    const batch = batchOf([['a.txt', '已入库']]);
    const id = titleAuthorId('已入库', '作者');
    batch.items[0].author = '作者';
    const preview = previewBatch(batch, [{ key: 'old:1', id, title: '已入库', author: '作者' }]);
    expect(preview.items[0].duplicate).toBe('new_version');
    expect(preview.items[0].duplicateOf).toBe('old:1');
    expect(preview.suspectedDuplicates).toBe(1);
    expect(hintDuplicate(batch.items[0], [{ key: 'x:1', id: 'other', title: '已入库', author: '作者' }])).toBeNull();
  });

  it('marks the same title twice inside one batch', () => {
    const batch = batchOf([['a.txt', '同名'], ['b.txt', '同名']]);
    markInBatchDuplicates(batch);
    expect(batch.items[0].duplicate).toBeUndefined();
    expect(batch.items[1]).toMatchObject({ duplicate: 'in_batch', duplicateOf: batch.items[0].id });
    expect(previewBatch(batch, []).inBatchDuplicates).toBe(1);
  });
});

describe('batch persistence surface', () => {
  it('rejects a tampered batch instead of silently repairing it', () => {
    const batch = batchOf([['a.txt', 'A']]);
    expect(validateBatches([batch])).toHaveLength(1);
    expect(() => validateBatches([{ ...batch, schema: 9 }])).toThrow();
    expect(() => validateBatches([{ ...batch, status: 'running', items: [{ ...batch.items[0], status: 'completed' }] }])).toThrow();
    expect(() => validateBatches([{ ...batch, items: [{ ...batch.items[0], staged: '../x' }] }])).toThrow();
    expect(() => validateBatches([{ ...batch, items: [{ ...batch.items[0], status: 'pending', attempts: 1000 }] }])).toThrow();
    expect(validateBatches(undefined)).toEqual([]);
  });

  it('keeps every unfinished batch and only the newest finished ones', () => {
    const make = (id: string, status: ImportBatch['status'], updatedAt: number) => ({ ...newBatch({ id, source: 'files' }, NOW), status, updatedAt });
    const batches = [
      make('11111111-0000-4000-8000-000000000001', 'running', NOW),
      ...Array.from({ length: 30 }, (_, index) => make(`${String(index + 10).padStart(8, '0')}-0000-4000-8000-000000000000`, 'completed', NOW + index)),
    ];
    const kept = trimBatches(batches, 5);
    expect(kept.filter((batch) => batch.status === 'running')).toHaveLength(1);
    expect(kept.filter((batch) => batch.status === 'completed').length).toBeLessThanOrEqual(4);
  });

  it('only ever hands completed items to the plan', () => {
    const batch = batchOf([['a.txt', 'A'], ['b.txt', 'B'], ['c.txt', 'C']]);
    beginBatch(batch, NOW);
    setItemStatus(batch, batch.items[0].id, 'completed', { bookKey: 'a:1' }, NOW + 1);
    setItemStatus(batch, batch.items[1].id, 'failed', { error: 'bad' }, NOW + 2);
    setItemStatus(batch, batch.items[2].id, 'needs_reselect', {}, NOW + 3);
    expect(completedBookKeys(batch)).toEqual(['a:1']);
    expect(batch.status).toBe('completed');
  });
});

describe('batch inputs stay inside the batch bounds', () => {
  it('rejects an empty or oversized selection', () => {
    const batch = batchOf([['a.txt', 'A']]);
    const tooMany: BatchItemInput[] = Array.from({ length: BATCH_ITEM_LIMIT + 1 }, (_, index) => ({ id: uuid(500 + index), name: `${index}.txt`, size: 1, title: `${index}` }));
    // The hard ceiling is reported as overflow, never as an exception.
    expect(addBatchItems(batch, tooMany, NOW).overflow).toBeGreaterThan(0);
    expect(() => beginBatch(batchOf([]), NOW)).toThrow('empty');
  });
});
