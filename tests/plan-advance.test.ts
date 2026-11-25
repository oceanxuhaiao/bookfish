import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';

let dir: string, time: number, lib: Library;
const now = () => time;
const idle = { routine: null, restUntil: null, active: undefined } as const;

function readAll() {
  const result = lib.readNext(4);
  if (result.complete) return;
  lib.finishMany(result.segments.map((segment) => ({ taskId: segment.taskId, segmentId: segment.segmentId, understanding: '' })));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-plan-advance-'));
  time = Date.parse('2026-10-02T02:00:00Z');
  lib = new Library({ dataDir: dir, now });
  lib.open();
});
afterEach(() => { lib.close(); rmSync(dir, { recursive: true, force: true }); });

function seed() {
  const first = lib.import({ filename: 'first.txt', title: '第一本', base64: Buffer.from('海风。'.repeat(900)).toString('base64') }).book;
  const second = lib.import({ filename: 'second.txt', title: '第二本', base64: Buffer.from('海浪。'.repeat(900)).toString('base64') }).book;
  lib.select(first.key);
  return { first, second };
}

describe('cross-book hand-off only ever follows a genuine completion', () => {
  it('refuses while the current book still has unread text', () => {
    const { first, second } = seed();
    lib.addToPlan([first.key, second.key], { source: 'user' });
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'current_incomplete' });
    expect(lib.status().current!.key).toBe(first.key);
  });

  it('refuses while a passage is offered but not yet confirmed', () => {
    const { first, second } = seed();
    lib.addToPlan([first.key, second.key], { source: 'user' });
    lib.select(second.key);
    const offered = lib.readNext(1);
    expect(offered.complete).toBe(false);
    expect(lib.status().pending).toBeTruthy();
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'current_incomplete' });
    lib.cancelPending();
    expect(lib.status().pending).toBeFalsy();
  });

  it('hands off to the next planned book and stamps its start in one snapshot', () => {
    const { first, second } = seed();
    lib.addToPlan([first.key, second.key], { source: 'user' });
    readAll();
    expect(lib.status().current!.complete).toBe(true);
    const result = lib.advancePlan(idle);
    expect(result).toMatchObject({ advanced: true, from: first.key, to: second.key });
    const plan = lib.planView();
    expect(plan.current?.bookKey).toBe(second.key);
    expect(plan.current?.startedAt).toBe(time);
    // The finished book is still on the shelf with all of its progress.
    const finished = lib.list().find((book) => book.key === first.key)!;
    expect(finished.complete).toBe(true);
  });

  it('does not hand off twice for the same completion', () => {
    const { first, second } = seed();
    lib.addToPlan([first.key, second.key], { source: 'user' });
    readAll();
    expect(lib.advancePlan(idle).advanced).toBe(true);
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'current_incomplete' });
  });

  it('waits for the finished book review, then allows a terminal failure', () => {
    const { first, second } = seed();
    lib.addToPlan([first.key, second.key], { source: 'user' });
    readAll();
    const job = lib.beginReview({ bookKey: first.key, requestId: 'advance-review' }).job;
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'review_pending' });
    lib.failReview({ jobId: job.id, reason: 'review attempt gave up' });
    expect(lib.advancePlan(idle).advanced).toBe(true);
  });

  it('respects pause, routine, rest and the plan switch', () => {
    const { first, second } = seed();
    lib.addToPlan([first.key, second.key], { source: 'user' });
    readAll();
    expect(lib.advancePlan({ ...idle, routine: { kind: 'sleep' } })).toEqual({ advanced: false, reason: 'routine' });
    expect(lib.advancePlan({ ...idle, restUntil: time + 60_000 })).toEqual({ advanced: false, reason: 'resting' });
    lib.updatePlanAction({ action: 'enable', enabled: false });
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'plan_disabled' });
    lib.updatePlanAction({ action: 'enable', enabled: true });
    lib.setPaused(true);
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'paused' });
    lib.setPaused(false);
    expect(lib.advancePlan(idle).advanced).toBe(true);
  });

  it('honours a deferral and skips an entry whose revision is gone', () => {
    const { first, second } = seed();
    const third = lib.import({ filename: 'third.txt', title: '第三本', base64: Buffer.from('沙滩。'.repeat(900)).toString('base64') }).book;
    lib.addToPlan([first.key, second.key, third.key], { source: 'user' });
    readAll();
    const secondItem = lib.planView().items.find((item) => item.bookKey === second.key)!;
    lib.updatePlanAction({ action: 'remove', itemId: secondItem.id, status: 'skipped' });
    // third is now next; drop it from the shelf so the plan has nothing readable.
    lib.remove(third.key);
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'plan_exhausted' });
  });

  it('stops at a deferred head instead of jumping past the user schedule', () => {
    const { first, second } = seed();
    const third = lib.import({ filename: 'third.txt', title: '第三本', base64: Buffer.from('沙滩。'.repeat(900)).toString('base64') }).book;
    lib.addToPlan([first.key, second.key, third.key], { source: 'user' });
    readAll();
    const secondItem = lib.planView().items.find((item) => item.bookKey === second.key)!;
    lib.updatePlan(draft => { draft.items.find((item) => item.id === secondItem.id)!.notBefore = time + 3_600_000; draft.revision += 1; });
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'deferred' });
  });

  it('reports an empty plan without touching the finished book', () => {
    const { first } = seed();
    lib.addToPlan([first.key], { source: 'user' });
    readAll();
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'plan_exhausted' });
    expect(lib.status().current!.key).toBe(first.key);
    expect(lib.status().current!.complete).toBe(true);
  });
});

describe('completion is measured, never inferred', () => {
  it('does not treat the last chapter as finished before its final segment', () => {
    const { first, second } = seed();
    lib.addToPlan([first.key, second.key], { source: 'user' });
    const current = lib.status().current!;
    // Confirm everything except the last segment, one segment at a time.
    while (lib.status().current!.confirmedSegments < current.totalSegments - 1) {
      const step = lib.readNext(1);
      if (step.complete) throw new Error('expected more text');
      lib.finishMany(step.segments.map((segment) => ({ taskId: segment.taskId, segmentId: segment.segmentId, understanding: '' })));
    }
    expect(lib.status().current!.complete).toBe(false);
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'current_incomplete' });
    readAll();
    expect(lib.status().current!.complete).toBe(true);
    expect(lib.advancePlan(idle).advanced).toBe(true);
  });
});
