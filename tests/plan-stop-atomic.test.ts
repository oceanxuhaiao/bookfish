import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeSync, fsyncSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';

let dir: string, time: number, lib: Library;
let failure: Error | null = null;
const now = () => time;
const idle = { routine: null, restUntil: null, active: undefined } as const;

/**
 * Every write goes through the injected commit path, so a single flag can make
 * the *next* snapshot fail exactly the way a crashed or full disk would.
 */
function open() {
  lib = new Library({ dataDir: dir, now, write: (file, state) => {
    if (failure) throw failure;
    const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const fd = openSync(temporary, 'wx');
    try { writeFileSync(fd, JSON.stringify(state), 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
  } });
  lib.open();
}
function close() { lib.close(); }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-plan-stop-'));
  time = Date.parse('2026-10-05T02:00:00Z');
  failure = null;
  open();
});
afterEach(() => { failure = null; try { lib.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

const seed = (titles: string[]) => titles.map((title) => lib.import({ filename: `${title}.txt`, title,
  base64: Buffer.from(`# ${title}\n` + '海风。'.repeat(900)).toString('base64') }).book);

function readOne(key: string) {
  lib.select(key);
  const read = lib.readNext(1);
  if (read.complete) throw new Error('expected text');
  lib.finishMany(read.segments.map((segment) => ({ taskId: segment.taskId, segmentId: segment.segmentId, understanding: '' })));
}

describe('stopping the current book is one atomic decision', () => {
  it('archives, invalidates and switches in a single commit', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    readOne(a.key);
    const pending = lib.readNext(1);
    expect(pending.complete).toBe(false);
    const progress = lib.list().find((book) => book.key === a.key)!.confirmedChars;
    const item = lib.planView().items.find((row) => row.bookKey === a.key)!;
    const result = lib.removeFromPlan(item.id, { status: 'skipped', stop: true, reason: 'stopped_by_user' });
    expect(result.to).toBe(b.key);
    expect(result.entry).toMatchObject({ bookKey: a.key, status: 'skipped' });
    expect(lib.status().current!.key).toBe(b.key);
    // The stopped book keeps every confirmed character and its unread text.
    const stopped = lib.list().find((book) => book.key === a.key)!;
    expect(stopped.confirmedChars).toBe(progress);
    expect(stopped.complete).toBe(false);
    // The stale offer on the old book is gone, not just ignored.
    expect(lib.status().pending).toBeFalsy();
    expect(lib.status().current!.key).toBe(b.key);
    // Plan, selection and startedAt agree.
    const view = lib.planView();
    expect(view.items.map((row) => row.bookKey)).toEqual([b.key]);
    expect(view.current?.bookKey).toBe(b.key);
    expect(view.current?.startedAt).toBe(time);
    expect(view.completedCount).toBe(0);
  });

  it('skips a deferred entry and picks the next readable one', () => {
    const [a, b, c] = seed(['甲', '乙', '丙']);
    lib.addToPlan([a.key, b.key, c.key], { source: 'user' });
    readOne(a.key);
    const deferred = lib.planView().items.find((row) => row.bookKey === b.key)!;
    lib.updatePlan((plan) => { plan.items.find((row) => row.id === deferred.id)!.notBefore = time + 86_400_000; plan.revision += 1; });
    const item = lib.planView().items.find((row) => row.bookKey === a.key)!;
    expect(lib.removeFromPlan(item.id, { status: 'skipped', stop: true }).to).toBe(c.key);
    expect(lib.status().current!.key).toBe(c.key);
  });

  it('leaves nothing behind when the commit fails, and the retry then succeeds', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    readOne(a.key);
    const progress = lib.list().find((book) => book.key === a.key)!.confirmedChars;
    const before = lib.planView();
    const item = before.items.find((row) => row.bookKey === a.key)!;

    failure = new Error('disk full while writing the plan');
    expect(() => lib.removeFromPlan(item.id, { status: 'skipped', stop: true })).toThrow('disk full');
    failure = null;

    // Not one field moved: the entry, the selection and the progress are intact.
    const after = lib.planView();
    expect(after.items.map((row) => row.bookKey)).toEqual([a.key, b.key]);
    expect(after.archive).toEqual([]);
    expect(lib.status().current!.key).toBe(a.key);
    expect(lib.list().find((book) => book.key === a.key)!.confirmedChars).toBe(progress);

    // The same request retried later behaves as if nothing had happened.
    expect(lib.removeFromPlan(item.id, { status: 'skipped', stop: true }).to).toBe(b.key);
    expect(lib.planView().items.map((row) => row.bookKey)).toEqual([b.key]);
  });

  it('reopens into a state that can continue reading, both after success and after failure', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    readOne(a.key);
    const item = lib.planView().items.find((row) => row.bookKey === a.key)!;

    failure = new Error('interrupted before commit');
    expect(() => lib.removeFromPlan(item.id, { status: 'skipped', stop: true })).toThrow();
    failure = null;
    close(); open();
    expect(lib.planView().items.map((row) => row.bookKey)).toEqual([a.key, b.key]);
    expect(lib.status().current!.key).toBe(a.key);
    // A restarted process can still advance: nothing was half-applied.
    const read = lib.readNext(1);
    expect(read.complete).toBe(false);

    lib.cancelPending();
    lib.removeFromPlan(item.id, { status: 'skipped', stop: true });
    close(); open();
    expect(lib.planView().items.map((row) => row.bookKey)).toEqual([b.key]);
    expect(lib.status().current!.key).toBe(b.key);
    expect(lib.planView().current?.startedAt).toBe(time);
  });

  it('never reports a switched selection without its plan entry', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    readOne(a.key);
    const item = lib.planView().items.find((row) => row.bookKey === a.key)!;
    lib.removeFromPlan(item.id, { status: 'skipped', stop: true });
    const view = lib.planView();
    const current = view.current;
    expect(current).not.toBeNull();
    expect(view.items.some((row) => row.bookKey === lib.status().current!.key)).toBe(true);
    expect(current!.startedAt).toBeDefined();
    // The stopped book is history now, and it is not silently marked finished.
    expect(view.archive.find((row) => row.bookKey === a.key)).toMatchObject({ status: 'skipped' });
    expect(view.completedCount).toBe(0);
  });

  it('refuses the stop when the only other planned book is deferred', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    readOne(a.key);
    const deferred = lib.planView().items.find((row) => row.bookKey === b.key)!;
    lib.updatePlan((plan) => { plan.items.find((row) => row.id === deferred.id)!.notBefore = time + 3_600_000; plan.revision += 1; });
    const item = lib.planView().items.find((row) => row.bookKey === a.key)!;
    expect(() => lib.removeFromPlan(item.id, { status: 'skipped', stop: true })).toThrow('No other planned book');
    expect(lib.planView().items).toHaveLength(2);
    expect(lib.status().current!.key).toBe(a.key);
  });

  it('stops a book that the plan was not driving, without touching the plan order', () => {
    const [a, b] = seed(['甲', '乙']);
    lib.addToPlan([a.key, b.key], { source: 'user' });
    // Read B as the selected book while A is first in the plan.
    readOne(b.key);
    const itemB = lib.planView().items.find((row) => row.bookKey === b.key)!;
    lib.removeFromPlan(itemB.id, { status: 'skipped', stop: true });
    expect(lib.status().current!.key).toBe(a.key);
    expect(lib.planView().items.map((row) => row.bookKey)).toEqual([a.key]);
    expect(lib.planView().current?.startedAt).toBe(time);
    void idle;
  });
});
