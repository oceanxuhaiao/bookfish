import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';

let dir: string, time: number, lib: Library;
const now = () => time;

function open() { lib = new Library({ dataDir: dir, now }); lib.open(); }
function close() { lib.close(); }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-plan-lib-'));
  time = Date.parse('2026-10-03T02:00:00Z');
  open();
});
afterEach(() => { try { lib.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

function seedBooks(titles: string[]) {
  return titles.map((title) => lib.import({ filename: `${title}.txt`, title,
    base64: Buffer.from(`第${title}章\n` + '海风。'.repeat(900)).toString('base64') }).book);
}

describe('the single plan lives in the one atomic snapshot', () => {
  it('keeps the order across a restart and never renumbers books', () => {
    const [a, b, c] = seedBooks(['甲', '乙', '丙']);
    lib.addToPlan([a.key, b.key, c.key], { source: 'user' });
    const before = lib.planView();
    expect(before.items.map((item) => item.title)).toEqual(['甲', '乙', '丙']);
    close(); open();
    const after = lib.planView();
    expect(after.items.map((item) => item.bookKey)).toEqual([a.key, b.key, c.key]);
    expect(after.items.map((item) => item.id)).toEqual(before.items.map((item) => item.id));
    expect(after.revision).toBe(before.revision);
  });

  it('stores the plan inside library.json, not in a second store', () => {
    const [a, b] = seedBooks(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    lib.updatePlanAction({ action: 'place', itemId: lib.planView().items[1].id, place: 'top' });
    const snapshot = JSON.parse(readFileSync(lib.file, 'utf8'));
    expect(snapshot.plan.schema).toBe(1);
    expect(snapshot.plan.items.map((item: { bookKey: string }) => item.bookKey)).toEqual([b.key, a.key]);
    expect(Array.isArray(snapshot.importBatches)).toBe(true);
  });

  it('reordering changes nothing else: text, progress, journal and reviews stay put', () => {
    const [a, b, c] = seedBooks(['甲', '乙', '丙']);
    lib.select(a.key);
    const read = lib.readNext(1);
    if (read.complete) throw new Error('expected text');
    lib.finishMany(read.segments.map((segment) => ({ taskId: segment.taskId, segmentId: segment.segmentId, understanding: '记住这片海。' })));
    lib.addToPlan([a.key, b.key, c.key], { source: 'user' });
    const beforeBook = lib.list().find((book) => book.key === a.key)!;
    const beforeJournal = lib.journal(a.key).items.length;
    const beforePlan = lib.planView();

    lib.updatePlanAction({ action: 'place', itemId: beforePlan.items[2].id, place: 'next' });
    expect(lib.planView().items.map((row) => row.bookKey)).toEqual([a.key, c.key, b.key]);
    lib.updatePlanAction({ action: 'move', itemId: lib.planView().items[2].id, to: 2 });
    expect(lib.planView().items.map((row) => row.bookKey)).toEqual([a.key, b.key, c.key]);

    const afterBook = lib.list().find((book) => book.key === a.key)!;
    expect(afterBook.revision).toBe(beforeBook.revision);
    expect(afterBook.totalChars).toBe(beforeBook.totalChars);
    expect(afterBook.confirmedChars).toBe(beforeBook.confirmedChars);
    expect(afterBook.confirmedSegments).toBe(beforeBook.confirmedSegments);
    expect(lib.journal(a.key).items.length).toBe(beforeJournal);
    expect(lib.reviews(a.key).versions).toEqual([]);
    expect(lib.reviews(a.key).jobs).toEqual([]);
    expect(lib.status().current!.key).toBe(a.key);
  });
});

describe('removing, skipping and stopping are three different promises', () => {
  it('locks the book being read against a plain removal', () => {
    const [a, b] = seedBooks(['甲', '乙']);
    lib.select(a.key);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    const item = lib.planView().items[0];
    expect(() => lib.removeFromPlan(item.id, { status: 'removed' })).toThrow('locked');
    expect(lib.planView().items).toHaveLength(2);
    expect(lib.status().current!.key).toBe(a.key);
  });

  it('skips a waiting book without marking it read or losing progress', () => {
    const [a, b] = seedBooks(['甲', '乙']);
    lib.select(a.key);
    const read = lib.readNext(1);
    if (read.complete) throw new Error('expected text');
    lib.finishMany(read.segments.map((segment) => ({ taskId: segment.taskId, segmentId: segment.segmentId, understanding: '' })));
    // Move on so the partially read book is waiting rather than locked.
    lib.select(b.key);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    const progress = lib.list().find((book) => book.key === a.key)!.confirmedChars;
    // `a` is waiting now; only the active book is locked.
    const item = lib.planView().items.find((row) => row.bookKey === a.key)!;
    lib.removeFromPlan(item.id, { status: 'skipped', reason: 'not_now' });
    const view = lib.planView();
    expect(view.items.map((row) => row.bookKey)).toEqual([b.key]);
    expect(view.completedCount).toBe(0);
    expect(view.archive[0]).toMatchObject({ bookKey: a.key, status: 'skipped', reason: 'not_now' });
    expect(lib.list().find((book) => book.key === a.key)!.confirmedChars).toBe(progress);
    expect(lib.list().some((book) => book.key === a.key)).toBe(true);
    expect(lib.status().current!.key).toBe(b.key);
    // Skipping is not finishing, so the book can be planned again.
    lib.addToPlan([a.key], { source: 'user' });
    expect(lib.planView().items.map((row) => row.bookKey)).toEqual([b.key, a.key]);
  });

  it('stops the current book only when asked, and keeps every byte of progress', () => {
    const [a, b] = seedBooks(['甲', '乙']);
    lib.select(a.key);
    const read = lib.readNext(1);
    if (read.complete) throw new Error('expected text');
    lib.finishMany(read.segments.map((segment) => ({ taskId: segment.taskId, segmentId: segment.segmentId, understanding: '' })));
    lib.addToPlan([a.key, b.key], { source: 'user' });
    const progress = lib.list().find((book) => book.key === a.key)!.confirmedChars;
    const item = lib.planView().items[0];
    const result = lib.removeFromPlan(item.id, { status: 'skipped', stop: true, reason: 'stopped_by_user' });
    expect(result.entry.status).toBe('skipped');
    expect(lib.status().current!.key).toBe(b.key);
    const kept = lib.list().find((book) => book.key === a.key)!;
    expect(kept.confirmedChars).toBe(progress);
    expect(kept.complete).toBe(false);
    expect(lib.planView().completedCount).toBe(0);
  });

  it('refuses to stop the last book instead of leaving it outside the plan while still reading', () => {
    const [a] = seedBooks(['甲']);
    lib.select(a.key);
    lib.addToPlan([a.key], { source: 'user' });
    const item = lib.planView().items[0];
    // Stopping means "end this one and continue with the next". With no next
    // revision the request is refused: nothing is archived, nothing is lost.
    expect(() => lib.removeFromPlan(item.id, { status: 'skipped', stop: true })).toThrow('No other planned book');
    expect(lib.planView().items.map((row) => row.bookKey)).toEqual([a.key]);
    expect(lib.status().current!.key).toBe(a.key);
    // Removing it while keeping it open is the honest alternative.
    lib.removeFromPlan(item.id, { status: 'skipped', keepReading: true, reason: 'stopped_reading_but_kept' });
    expect(lib.planView().items).toEqual([]);
    expect(lib.status().current!.key).toBe(a.key);
    expect(lib.list()).toHaveLength(1);
  });
});

describe('plan additions are idempotent and keep their source', () => {
  it('ignores duplicates and books that are not on the shelf', () => {
    const [a, b] = seedBooks(['甲', '乙']);
    lib.addToPlan([a.key, 'nope:1', b.key, a.key], { source: 'user' });
    const view = lib.planView();
    expect(view.items.map((row) => row.bookKey)).toEqual([a.key, b.key]);
    expect(view.items.map((row) => row.source)).toEqual(['user', 'user']);
  });

  it('archives an entry whose revision disappeared from the shelf on the next open', () => {
    const [a, b] = seedBooks(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    lib.remove(b.key);
    close(); open();
    const view = lib.planView();
    expect(view.items.map((row) => row.bookKey)).toEqual([a.key]);
    expect(view.archive.find((entry) => entry.bookKey === b.key)).toMatchObject({ status: 'removed', reason: 'book_removed' });
  });

  it('keeps the legacy `selection.queue` projection in plan order', () => {
    const [a, b, c] = seedBooks(['甲', '乙', '丙']);
    lib.select(a.key);
    lib.addToPlan([a.key, b.key, c.key], { source: 'user' });
    expect(lib.selection().queue.map((row) => row.bookKey)).toEqual([a.key, b.key, c.key]);
    expect(lib.selection().queue.map((row) => row.status)).toEqual(['active', 'queued', 'queued']);
    lib.updatePlanAction({ action: 'place', itemId: lib.planView().items[2].id, place: 'next' });
    expect(lib.selection().queue.map((row) => row.bookKey)).toEqual([a.key, c.key, b.key]);
    expect(lib.selection().queue.map((row) => row.status)).toEqual(['active', 'queued', 'queued']);
  });
});

describe('series are organisation only', () => {
  it('keeps group members together when the group moves', () => {
    const [a, b, c, d] = seedBooks(['甲', '乙', '丙', '丁']);
    lib.addToPlan([a.key, b.key, c.key, d.key], { source: 'user' });
    const view = lib.planView();
    const series = lib.editPlanSeries({ action: 'create', name: '四部曲', itemIds: [view.items[1].id, view.items[2].id] });
    const group = series.series.find((row) => row.name === '四部曲')!;
    expect(group.count).toBe(2);
    const moved = lib.movePlanSeries(group.id, 1);
    expect(moved.view.items.map((row) => row.bookKey)).toEqual([b.key, c.key, a.key, d.key]);
    expect(moved.view.items.filter((row) => row.seriesId === group.id).map((row) => row.position)).toEqual([1, 2]);
    // Renaming and ungrouping never reorder anything.
    lib.editPlanSeries({ action: 'rename', seriesId: group.id, name: '四本一起' });
    expect(lib.planView().series[0].name).toBe('四本一起');
    lib.editPlanSeries({ action: 'delete', seriesId: group.id });
    expect(lib.planView().series).toEqual([]);
    expect(lib.planView().items.map((row) => row.bookKey)).toEqual([b.key, c.key, a.key, d.key]);
  });
});
