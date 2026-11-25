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
  dir = mkdtempSync(join(tmpdir(), 'bookfish-plan-combo-'));
  time = Date.parse('2026-10-10T02:00:00Z');
  open();
});
afterEach(() => { try { lib.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

const seed = (titles: string[]) => titles.map((title) => lib.import({ filename: `${title}.txt`, title,
  base64: Buffer.from(`# ${title}\n` + '海风。'.repeat(900)).toString('base64') }).book);

function finish(key: string) {
  lib.select(key);
  for (let guard = 0; guard < 40; guard++) {
    const read = lib.readNext(4);
    if (read.complete) return;
    lib.finishMany(read.segments.map((segment) => ({ taskId: segment.taskId, segmentId: segment.segmentId, understanding: '' })));
  }
  throw new Error('book did not finish');
}

describe('user reordering and an automatic hand-off can happen in either order', () => {
  it('honours the order the user set just before the hand-off', () => {
    const [a, b, c] = seed(['甲', '乙', '丙']);
    lib.addToPlan([a.key, b.key, c.key], { source: 'user' });
    finish(a.key);
    // The user moves C right after A while A is finishing.
    lib.updatePlanAction({ action: 'place', itemId: lib.planView().items[2].id, place: 'next' });
    expect(lib.planView().items.map((row) => row.bookKey)).toEqual([a.key, c.key, b.key]);
    expect(lib.advancePlan(idle)).toMatchObject({ advanced: true, to: c.key });
    expect(lib.status().current!.key).toBe(c.key);
    expect(lib.planView().items.map((row) => row.bookKey)).toEqual([c.key, b.key]);
    expect(lib.planView().completedCount).toBe(1);
  });

  it('keeps a reorder that arrives after the hand-off coherent', () => {
    const [a, b, c] = seed(['甲', '乙', '丙']);
    lib.addToPlan([a.key, b.key, c.key], { source: 'user' });
    finish(a.key);
    expect(lib.advancePlan(idle)).toMatchObject({ advanced: true, to: b.key });
    // B is being read, so nothing may be placed before it.
    lib.updatePlanAction({ action: 'place', itemId: lib.planView().items[1].id, place: 'top' });
    const view = lib.planView();
    expect(view.items.map((row) => row.bookKey)).toEqual([b.key, c.key]);
    expect(view.current?.bookKey).toBe(b.key);
    expect(lib.selection().queue.map((row) => row.bookKey)).toEqual([b.key, c.key]);
  });

  it('rejects reordering the book that is being read', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    lib.select(a.key);
    const activeItem = lib.planView().items[0];
    expect(() => lib.updatePlanAction({ action: 'move', itemId: activeItem.id, to: 2 })).toThrow('locked');
    expect(() => lib.updatePlanAction({ action: 'place', itemId: activeItem.id, place: 'bottom' })).toThrow('locked');
    expect(lib.planView().items.map((row) => row.bookKey)).toEqual([a.key, b.key]);
  });
});

describe('a completion callback that arrives while the user paused', () => {
  it('records the completion but does not switch books', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    finish(a.key);
    lib.setPaused(true);
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'paused' });
    // The plan tells the truth even though nothing was switched.
    expect(lib.planView().completedCount).toBe(1);
    expect(lib.planView().items.map((row) => row.bookKey)).toEqual([b.key]);
    expect(lib.status().current!.key).toBe(a.key);
    // Resuming lets the same completion finish its hand-off.
    lib.setPaused(false);
    expect(lib.advancePlan(idle)).toMatchObject({ advanced: true, to: b.key });
    expect(lib.planView().completedCount).toBe(1);
  });

  it('does not switch while a daily routine gate is closed', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    finish(a.key);
    expect(lib.advancePlan({ ...idle, routine: { kind: 'sleep' } })).toEqual({ advanced: false, reason: 'routine' });
    expect(lib.planView().completedCount).toBe(1);
    expect(lib.status().current!.key).toBe(a.key);
    expect(lib.advancePlan(idle).advanced).toBe(true);
  });
});

describe('a review pending across a restart is settled, never silently dropped', () => {
  it('blocks the hand-off while the job is alive and continues once it is terminal', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    finish(a.key);
    const job = lib.beginReview({ bookKey: a.key, requestId: 'combo-review' }).job;
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'review_pending' });

    // A restart cannot resume a half-finished cognition job: it is cancelled with
    // a recorded reason, which is a terminal state and therefore allows the
    // hand-off. The completion itself was already archived before the restart.
    close(); open();
    expect(lib.planView().completedCount).toBe(1);
    expect(lib.status().current!.key).toBe(a.key);
    expect(lib.advancePlan(idle)).toMatchObject({ advanced: true, to: b.key });
    expect(lib.planView().completedCount).toBe(1);
    expect(lib.planView().archive.filter((row) => row.bookKey === a.key)).toHaveLength(1);
    expect(lib.reviews(a.key).jobs.find((row) => row.id === job.id)?.status).toBe('cancelled');
  });

  it('continues after an explicit terminal failure without a restart', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    finish(a.key);
    const job = lib.beginReview({ bookKey: a.key, requestId: 'combo-review-2' }).job;
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'review_pending' });
    lib.failReview({ jobId: job.id, reason: 'gave up' });
    expect(lib.advancePlan(idle)).toMatchObject({ advanced: true, to: b.key });
  });
});
