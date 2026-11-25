import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';

let dir: string, time: number, lib: Library;
const now = () => time;
const idle = { routine: null, restUntil: null, active: undefined } as const;

function open() { lib = new Library({ dataDir: dir, now }); lib.open(); }
function close() { lib.close(); }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-plan-archive-'));
  time = Date.parse('2026-10-04T02:00:00Z');
  open();
});
afterEach(() => { try { lib.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

/** Read the whole book so `frontier === segments.length`, which is a real completion. */
function finish(key: string) {
  lib.select(key);
  for (let guard = 0; guard < 40; guard++) {
    const read = lib.readNext(4);
    if (read.complete) return;
    lib.finishMany(read.segments.map((segment) => ({ taskId: segment.taskId, segmentId: segment.segmentId, understanding: '' })));
  }
  throw new Error('book did not finish');
}

const seed = (titles: string[]) => titles.map((title) => lib.import({ filename: `${title}.txt`, title,
  base64: Buffer.from(`# ${title}\n` + '海风。'.repeat(900)).toString('base64') }).book);

describe('a finished book ends its plan entry in the same commit as the hand-off', () => {
  it('archives A while switching to B, without any restart', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    finish(a.key);
    const result = lib.advancePlan(idle);
    expect(result).toMatchObject({ advanced: true, from: a.key, to: b.key });
    const view = lib.planView();
    expect(view.items.map((row) => row.bookKey)).toEqual([b.key]);
    expect(view.completedCount).toBe(1);
    expect(view.archive[0]).toMatchObject({ bookKey: a.key, status: 'completed', reason: 'finished_while_planned' });
    expect(view.current?.bookKey).toBe(b.key);
    // The finished revision keeps its shelf copy, its progress and its journal.
    const finished = lib.list().find((book) => book.key === a.key)!;
    expect(finished.complete).toBe(true);
    expect(finished.confirmedSegments).toBe(finished.totalSegments);
    expect(lib.journal(a.key).items).toEqual([]);
  });

  it('keeps both archived entries after two hand-offs', () => {
    const [a, b, c] = seed(['甲', '乙', '丙']);
    lib.addToPlan([a.key, b.key, c.key], { source: 'user' });
    finish(a.key);
    expect(lib.advancePlan(idle)).toMatchObject({ advanced: true, to: b.key });
    finish(b.key);
    expect(lib.advancePlan(idle)).toMatchObject({ advanced: true, to: c.key });
    const view = lib.planView();
    expect(view.items.map((row) => row.bookKey)).toEqual([c.key]);
    expect(view.completedCount).toBe(2);
    expect(view.archive.map((row) => [row.bookKey, row.status])).toEqual([[b.key, 'completed'], [a.key, 'completed']]);
  });

  it('archives the last book even though nothing comes next', () => {
    const [a, b, c] = seed(['甲', '乙', '丙']);
    lib.addToPlan([a.key, b.key, c.key], { source: 'user' });
    finish(a.key); lib.advancePlan(idle);
    finish(b.key); lib.advancePlan(idle);
    finish(c.key);
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'plan_exhausted' });
    const view = lib.planView();
    expect(view.items).toEqual([]);
    expect(view.completedCount).toBe(3);
    // The last book stays selected and complete: nothing is faked, nothing lost.
    expect(lib.status().current!.key).toBe(c.key);
    expect(lib.status().current!.complete).toBe(true);
    expect(lib.list().filter((book) => book.complete)).toHaveLength(3);
  });

  it('does not archive twice for a repeated completion callback', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    finish(a.key);
    expect(lib.advancePlan(idle).advanced).toBe(true);
    const afterFirst = lib.planView();
    expect(afterFirst.completedCount).toBe(1);
    // A late duplicate callback now sees an unfinished current book.
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'current_incomplete' });
    expect(lib.planView().completedCount).toBe(1);
    expect(lib.planView().archive.filter((row) => row.bookKey === a.key)).toHaveLength(1);
  });

  it('archives without switching while the finished review is still pending, then hands off', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    finish(a.key);
    const job = lib.beginReview({ bookKey: a.key, requestId: 'archive-review' }).job;
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'review_pending' });
    // Bookkeeping already happened: the plan no longer waits for A.
    expect(lib.planView().completedCount).toBe(1);
    expect(lib.planView().items.map((row) => row.bookKey)).toEqual([b.key]);
    expect(lib.status().current!.key).toBe(a.key);
    lib.failReview({ jobId: job.id, reason: 'attempt failed' });
    expect(lib.advancePlan(idle)).toMatchObject({ advanced: true, to: b.key });
    expect(lib.planView().completedCount).toBe(1);
  });

  it('never projects a finished entry as a queued row', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    finish(a.key);
    // A is complete but the hand-off has not run yet.
    expect(lib.selection().queue.map((row) => row.bookKey)).toEqual([b.key]);
    lib.advancePlan(idle);
    expect(lib.selection().queue.map((row) => row.bookKey)).toEqual([b.key]);
    expect(lib.selection().queue.map((row) => row.status)).toEqual(['active']);
  });

  it('refuses to rewrite a finished entry as skipped or removed', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    finish(a.key);
    lib.advancePlan(idle);
    const archivedItem = lib.planView().archive.find((row) => row.bookKey === a.key)!;
    expect(archivedItem.status).toBe('completed');
    expect(() => lib.removeFromPlan(archivedItem.id, { status: 'skipped' })).toThrow('not found');
    expect(lib.planView().archive.find((row) => row.bookKey === a.key)!.status).toBe('completed');
  });

  it('keeps the archive and the order across a restart', () => {
    const [a, b, c] = seed(['甲', '乙', '丙']);
    lib.addToPlan([a.key, b.key, c.key], { source: 'user' });
    finish(a.key);
    lib.advancePlan(idle);
    const before = lib.planView();
    close(); open();
    const after = lib.planView();
    expect(after.items.map((row) => row.bookKey)).toEqual(before.items.map((row) => row.bookKey));
    expect(after.completedCount).toBe(1);
    expect(after.archive[0]).toMatchObject({ bookKey: a.key, status: 'completed' });
    // The hand-off already recorded the start of B, so nothing is stamped twice.
    expect(after.current?.bookKey).toBe(b.key);
    expect(after.current?.startedAt).toBe(before.current?.startedAt);
  });
});
