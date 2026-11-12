import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunPhase, WorldHost } from 'cortico/core/types.ts';
import { BOOKFISH_DEFAULTS, readingLimits } from '../src/config.ts';
import { Library } from '../src/library.ts';
import { ReadingScheduler } from '../src/scheduler.ts';
import { FakeHost } from './helpers/fake-host.ts';

let dir: string, time: number, lib: Library, cfg: typeof BOOKFISH_DEFAULTS, host: FakeHost;
let scheduler: ReadingScheduler;
type Deferred = Parameters<WorldHost['pushDeferred']>[0];
let queued: Deferred[];
function phase(state: RunPhase['state']) { scheduler.onRunPhase({ state, running: [], enteredAt: new Date(time).toISOString() }); }
async function advance(ms = 600000) { while (ms > 0) { const step = Math.min(ms, 5000); time += step; ms -= step; await scheduler.tick(); } }
function active() { const id = scheduler.status().active?.opportunityId; if (!id) throw new Error('expected an active opportunity'); return id; }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-batch-')); time = Date.parse('2026-11-07T02:00:00Z');
  cfg = { ...BOOKFISH_DEFAULTS, realRoutineEnabled: false, automaticReading: true, readingBatchSegments: 3 };
  lib = new Library({ dataDir: dir, now: () => time }); lib.open();
  const imported = lib.import({ filename: 'batch.txt', title: '合成批量样本', base64: Buffer.from('海边有鱼。'.repeat(5000)).toString('base64') });
  lib.select(imported.book.key); host = new FakeHost(); queued = [];
  host.pushDeferred = (event) => { queued.push(event); };
  scheduler = new ReadingScheduler(lib, cfg, 'Asia/Shanghai', () => time); scheduler.start(host); phase('idle');
});
afterEach(() => { scheduler.stop(); lib.close(); rmSync(dir, { recursive: true, force: true }); });

describe('batch reading keeps atomic, contiguous progress', () => {
  it('defaults to two segments per opportunity and keeps the explicit override', () => {
    expect(BOOKFISH_DEFAULTS.readingBatchSegments).toBe(2);
    expect(readingLimits(BOOKFISH_DEFAULTS).batch).toBe(2);
    expect(readingLimits({ ...BOOKFISH_DEFAULTS, readingBatchSegments: 1 }).batch).toBe(1);
    expect(readingLimits({ ...BOOKFISH_DEFAULTS, readingBatchSegments: 9 as number }).batch).toBe(2);
  });

  it('supplies a contiguous run in one read and confirms it in one call', async () => {
    const read = lib.readNext(3);
    if (read.complete) throw new Error('expected text');
    expect(read.segments.map(s => s.segmentId)).toEqual([0, 1, 2]);
    expect(read.taskId).toBe(read.segments[0].taskId);
    expect(read.batch.count).toBe(3);
    expect(read.batch.chars).toBeGreaterThan(3000);
    // Reading itself never advances progress.
    expect(lib.status().current!.confirmedSegments).toBe(0);
    const result = lib.finishMany(read.segments.map(s => ({ taskId: s.taskId, segmentId: s.segmentId, understanding: '' })));
    expect(result.confirmed).toBe(3);
    expect(result.frontier).toBe(3);
    expect(result.stoppedAt).toBeUndefined();
    expect(lib.status().current!.confirmedSegments).toBe(3);
    // A replay returns the original receipts without counting twice.
    const replay = lib.finishMany(read.segments.map(s => ({ taskId: s.taskId, segmentId: s.segmentId, understanding: '' })));
    expect(replay.confirmed).toBe(3);
    expect(replay.receipts.every(r => r.understanding === '')).toBe(true);
    expect(lib.status().current!.confirmedSegments).toBe(3);
  });

  it('advances only the prefix before a malformed item and leaves the rest unread', () => {
    const read = lib.readNext(3);
    if (read.complete) throw new Error('expected text');
    const items = read.segments.map((s, i) => ({ taskId: s.taskId, segmentId: s.segmentId,
      understanding: i === 1 ? 'x'.repeat(601) : '这一段有印象。' }));
    const result = lib.finishMany(items);
    expect(result.confirmed).toBe(1);
    expect(result.frontier).toBe(1);
    expect(result.stoppedAt?.index).toBe(1);
    expect(lib.status().current!.confirmedSegments).toBe(1);
    // The failed run is still pending and can be retried without re-reading the prefix.
    const retry = lib.finishMany([
      { taskId: read.segments[1].taskId, segmentId: 1, understanding: '补确认。' },
      { taskId: read.segments[2].taskId, segmentId: 2, understanding: '再补确认。' },
    ]);
    expect(retry.confirmed).toBe(2);
    expect(lib.status().current!.confirmedSegments).toBe(3);
  });

  it('re-mount cancels in-flight batch work and offers a fresh contiguous run at the frontier', () => {
    const read = lib.readNext(3);
    if (read.complete) throw new Error('expected text');
    lib.close(); lib.open();
    // A remount invalidates pending text by design: nothing may be confirmed later.
    expect(lib.status().pending).toBeNull();
    expect(lib.status().current!.confirmedSegments).toBe(0);
    const again = lib.readNext(2);
    if (again.complete) throw new Error('expected text');
    expect(again.taskId).not.toBe(read.taskId);
    expect(again.segments.map(s => s.segmentId)).toEqual([0, 1]);
    lib.finish({ taskId: again.segments[0].taskId, bookKey: again.bookKey, segmentId: 0, understanding: '' });
    lib.cancelPending();
    const fresh = lib.readNext(2);
    if (fresh.complete) throw new Error('expected text');
    expect(fresh.segments.map(s => s.segmentId)).toEqual([1, 2]);
  });
});

describe('scheduler batch, cap and self-correcting retries', () => {
  it('confirms a paced batch and accounts every character', async () => {
    await advance(); const id = active();
    const batch = scheduler.read(id);
    if (batch.complete) throw new Error('expected text');
    expect(batch.segments).toHaveLength(3);
    expect(scheduler.status().budget).toMatchObject({ tasks: 3 });
    expect(scheduler.read(id)).toEqual(batch);
    const result = scheduler.finishBatch(id, batch.segments.map(s => ({ taskId: s.taskId, segmentId: s.segmentId, understanding: '' })));
    expect(result.confirmed).toBe(3);
    expect(lib.status().current!.confirmedSegments).toBe(3);
    expect(() => scheduler.read(id)).toThrow(/one segment/);
  });

  it('routes a batch-level episode through the scheduler exactly once', async () => {
    await advance(); const id = active();
    const batch = scheduler.read(id);
    if (batch.complete) throw new Error('expected text');
    const target = batch.segments[2];
    const episode = { trigger: '转折', interpretation: '没想到', evidence: [{ segmentId: target.segmentId, quote: '海边有鱼', start: target.segment.start }] };
    const items = batch.segments.map(s => ({ taskId: s.taskId, segmentId: s.segmentId, understanding: '读到了。' }));
    const result = scheduler.finishBatch(id, items, episode);
    expect(result.confirmed).toBe(3);
    expect(result.receipts.filter(r => r.episodeId)).toHaveLength(1);
    expect(result.receipts[2].episodeId).toBeTruthy();
    expect(lib.episode(result.receipts[2].episodeId!).episode.content.trigger).toBe('转折');
  });

  it('rejects a batch item that belongs to another opportunity', async () => {
    await advance(); const id = active();
    const batch = scheduler.read(id);
    if (batch.complete) throw new Error('expected text');
    const forged = batch.segments.map(s => ({ taskId: s.taskId, segmentId: s.segmentId, understanding: '' }));
    forged[2] = { ...forged[2], taskId: 'not-this-opportunity' };
    let message = '';
    try { scheduler.finishBatch(id, forged); } catch (error) { message = String(error); }
    expect(message).toMatch(/belong/);
    expect(message).toContain(batch.segments[0].taskId);
    expect(lib.status().current!.confirmedSegments).toBe(0);
  });

  it('stops new automatic reading at the configured daily task cap but keeps explicit Read now', async () => {
    cfg.dailyReadingCap = 2;
    await advance(); const first = active(); const batch = scheduler.read(first);
    if (batch.complete) throw new Error('expected text');
    scheduler.finishBatch(first, batch.segments.map(s => ({ taskId: s.taskId, segmentId: s.segmentId, understanding: '' })));
    expect(scheduler.status().budget.taskCap).toBe(2);
    expect(scheduler.status().budget.capReached).toBe(true);
    await advance(); await scheduler.tick();
    expect(scheduler.status().active).toBeNull();
    expect(scheduler.status().reason).toBe('daily_cap');
    // An explicit panel request is still allowed by the product rule.
    const now = await scheduler.requestNow(lib.status().current!.key);
    expect(now.accepted).toBe(true);
  });

  it('turns a repeated malformed confirmation into a self-correcting hint instead of a retry storm', async () => {
    await advance(); const id = active();
    const read = scheduler.read(id, 1);
    if (read.complete) throw new Error('expected text');
    const quote = read.segment.text.slice(0, 3);
    const bad = { opportunityId: id, taskId: read.taskId, bookKey: read.bookKey, segmentId: read.segmentId, understanding: '有感想。',
      episode: { trigger: '触发', interpretation: '解释', evidence: [{ segmentId: read.segmentId, quote: `${quote}不存在的文字` }] } };
    expect(() => scheduler.finish(bad)).toThrow(/Evidence quote/);
    expect(() => scheduler.finish(bad)).toThrow(/empty understanding/);
    expect(lib.status().current!.confirmedSegments).toBe(0);
    const ok = scheduler.finish({ opportunityId: id, taskId: read.taskId, bookKey: read.bookKey, segmentId: read.segmentId, understanding: '' });
    expect(ok.duplicate).toBe(false);
    expect(lib.status().current!.confirmedSegments).toBe(1);
  });

  it('attaches one optional batch episode to the latest cited segment', () => {
    const read = lib.readNext(3);
    if (read.complete) throw new Error('expected text');
    const items = read.segments.map(s => ({ taskId: s.taskId, segmentId: s.segmentId, understanding: '读到。' }));
    const target = read.segments[1];
    const episode = { trigger: '起风', interpretation: '海面不太平', evidence: [{ segmentId: target.segmentId, quote: '海边有鱼', start: target.segment.start }] };
    const result = lib.finishMany(items, undefined, { episode });
    expect(result.confirmed).toBe(3);
    expect(result.receipts[0].episodeId).toBeUndefined();
    expect(result.receipts[1].episodeId).toBeTruthy();
    expect(result.receipts[2].episodeId).toBeUndefined();
    const saved = lib.episode(result.receipts[1].episodeId!);
    expect(saved.episode.kind).toBe('reading');
    expect(saved.evidence[0]).toMatchObject({ segmentId: target.segmentId, exactTextMatched: true });
    expect(lib.timeline().items.find(i => i.segmentId === target.segmentId)?.episodeId).toBe(result.receipts[1].episodeId);
  });

  it('rejects a batch episode that cites no segment supplied in the batch', () => {
    const read = lib.readNext(3);
    if (read.complete) throw new Error('expected text');
    const items = read.segments.map(s => ({ taskId: s.taskId, segmentId: s.segmentId, understanding: '' }));
    const episode = { trigger: '触发', interpretation: '解释', evidence: [{ segmentId: read.segments[0].segmentId, quote: '海边有鱼', start: read.segments[0].segment.start }] };
    expect(() => lib.finishMany(items, undefined, { episode: { ...episode, evidence: [{ segmentId: 50, quote: '海边有鱼', start: 0 }] } })).toThrow(/must quote at least one segment/);
    expect(lib.status().current!.confirmedSegments).toBe(0);
  });

  it('rejects an episode attached both to the batch and to one confirmation', () => {
    const read = lib.readNext(2);
    if (read.complete) throw new Error('expected text');
    const target = read.segments[0];
    const episode = { trigger: '触发', interpretation: '解释', evidence: [{ segmentId: target.segmentId, quote: '海边有鱼', start: target.segment.start }] };
    const items = read.segments.map((s, i) => ({ taskId: s.taskId, segmentId: s.segmentId, understanding: '', ...(i === 0 ? { episode } : {}) }));
    expect(() => lib.finishMany(items, undefined, { episode })).toThrow(/not both/);
    expect(lib.status().current!.confirmedSegments).toBe(0);
  });

  it('accepts one confirmation per segment inside the same opportunity', async () => {
    await advance(); const id = active();
    const batch = scheduler.read(id);
    if (batch.complete) throw new Error('expected text');
    expect(batch.segments).toHaveLength(3);
    for (const [index, segment] of batch.segments.entries()) {
      const receipt = scheduler.finish({ opportunityId: id, taskId: segment.taskId, bookKey: batch.bookKey, segmentId: segment.segmentId, understanding: `第${index + 1}段。` });
      expect(receipt.duplicate).toBe(false);
    }
    expect(lib.status().current!.confirmedSegments).toBe(3);
    expect(scheduler.status().active).toBeNull();
    expect(() => scheduler.read(id)).toThrow(/one segment/);
  });

  it('never lets a finished opportunity confirm its leftover pending slots', async () => {
    await advance(); const id = active();
    const batch = scheduler.read(id);
    if (batch.complete) throw new Error('expected text');
    const items = batch.segments.map((s, i) => ({ taskId: s.taskId, segmentId: s.segmentId, understanding: i === 2 ? 'x'.repeat(601) : '读到。' }));
    const first = scheduler.finishBatch(id, items);
    expect(first.confirmed).toBe(2);
    expect(lib.status().current!.confirmedSegments).toBe(2);
    // The third slot is still pending, but the opportunity is over: no late confirmation.
    expect(() => scheduler.finishBatch(id, items)).toThrow(/stale/);
    expect(lib.status().current!.confirmedSegments).toBe(2);
  });

  it('serialises a batch replay after completion without double counting', async () => {    await advance(); const id = active();
    const batch = scheduler.read(id);
    if (batch.complete) throw new Error('expected text');
    const items = batch.segments.map(s => ({ taskId: s.taskId, segmentId: s.segmentId, understanding: '读到了。' }));
    const first = scheduler.finishBatch(id, items);
    const again = scheduler.finishBatch(id, items);
    expect(first.confirmed).toBe(3);
    expect(again.confirmed).toBe(3);
    expect(lib.status().current!.confirmedSegments).toBe(3);
    expect(scheduler.status().budget.tasks).toBe(3);
  });
});
