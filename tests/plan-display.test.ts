import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';

let dir: string, time: number, lib: Library;
const now = () => time;
const idle = { routine: null, restUntil: null, active: undefined } as const;

function open() { lib = new Library({ dataDir: dir, now }); lib.open(); }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-plan-display-'));
  time = Date.parse('2026-10-14T02:00:00Z');
  open();
});
afterEach(() => { try { lib.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

const seed = (titles: string[]) => titles.map((title) => lib.import({ filename: `${title}.txt`, title,
  base64: Buffer.from(`# ${title}\n` + '海风。'.repeat(400)).toString('base64') }).book);

function finish(key: string) {
  lib.select(key);
  for (let guard = 0; guard < 40; guard++) {
    const read = lib.readNext(4);
    if (read.complete) return;
    lib.finishMany(read.segments.map((segment) => ({ taskId: segment.taskId, segmentId: segment.segmentId, understanding: '' })));
  }
  throw new Error('book did not finish');
}

describe('the book being read is shown even when it is not in the plan', () => {
  it('reports a current book that was never added to the plan', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.select(a.key);
    const read = lib.readNext(1);
    if (read.complete) throw new Error('expected text');
    lib.finishMany(read.segments.map((segment) => ({ taskId: segment.taskId, segmentId: segment.segmentId, understanding: '' })));
    lib.addToPlan([b.key], { source: 'user' });

    const view = lib.planView();
    expect(view.reading).toMatchObject({ bookKey: a.key, title: '甲', inPlan: false, complete: false });
    expect(view.reading!.progress).toBeGreaterThan(0);
    // Outside the plan it does not touch the plan's own numbers or its next book.
    expect(view.total).toBe(1);
    expect(view.items.map((item) => item.bookKey)).toEqual([b.key]);
    expect(view.next?.bookKey).toBe(b.key);
    expect(view.current).toBeNull();
  });

  it('keeps the current book visible when the plan is empty', () => {
    const [a] = seed(['甲']);
    lib.select(a.key);
    const view = lib.planView();
    expect(view.total).toBe(0);
    expect(view.reading).toMatchObject({ bookKey: a.key, inPlan: false });
    expect(view.current).toBeNull();
  });

  it('marks the current book as planned when it is in the playlist', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.select(a.key);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    const view = lib.planView();
    expect(view.reading).toMatchObject({ bookKey: a.key, inPlan: true });
    expect(view.current?.bookKey).toBe(a.key);
    expect(view.total).toBe(2);
  });

  it('still shows a finished current book that has no successor', () => {
    const [a] = seed(['甲']);
    lib.addToPlan([a.key], { source: 'user' });
    finish(a.key);
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'plan_exhausted' });
    const view = lib.planView();
    expect(view.reading).toMatchObject({ bookKey: a.key, complete: true, inPlan: false });
    expect(view.completedCount).toBe(1);
    expect(view.total).toBe(0);
  });

  it('reports the current book after an upgrade that never planned it', () => {
    const [a] = seed(['甲']);
    lib.select(a.key);
    lib.close();
    open();
    expect(lib.planView().reading).toMatchObject({ bookKey: a.key, inPlan: false });
    expect(lib.planView().total).toBe(0);
  });

  it('drops to no reading book when nothing is selected', () => {
    seed(['甲']);
    expect(lib.planView().reading).toBeNull();
  });

  it('keeps a removed-but-still-read book in the reading slot', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.select(a.key);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    const item = lib.planView().items[0];
    lib.removeFromPlan(item.id, { status: 'removed', keepReading: true, reason: 'kept_reading' });
    const view = lib.planView();
    expect(view.items.map((row) => row.bookKey)).toEqual([b.key]);
    // Still the current book, but no longer part of the plan.
    expect(view.reading).toMatchObject({ bookKey: a.key, inPlan: false });
    expect(lib.status().current!.key).toBe(a.key);
  });
});

describe('history completeness is part of the plan view', () => {
  it('a fresh library reports complete history', () => {
    seed(['甲']);
    const view = lib.planView();
    expect(view.statsComplete).toBe(true);
    expect(view.completedCount).toBe(0);
  });

  it('a legacy plan without counters reports a lower bound, not a total', () => {
    const [a] = seed(['甲']);
    lib.addToPlan([a.key], { source: 'user' });
    finish(a.key);
    // The finished book is archived when the plan advances past it.
    expect(lib.advancePlan(idle)).toEqual({ advanced: false, reason: 'plan_exhausted' });
    expect(lib.planView().completedCount).toBe(1);

    // Rewrite the snapshot as a pre-v1.2 file: counters (and the marker) did
    // not exist yet, so hydration must backfill and flag the history as
    // incomplete instead of presenting the archive window as the full total.
    lib.close();
    const file = join(dir, 'bookfish', 'library.json');
    const state = JSON.parse(readFileSync(file, 'utf8')) as { plan: { stats?: unknown; statsComplete?: unknown } };
    delete state.plan.stats;
    delete state.plan.statsComplete;
    writeFileSync(file, JSON.stringify(state));
    open();

    const view = lib.planView();
    expect(view.completedCount).toBe(1);
    expect(view.statsComplete).toBe(false);
  });
});
