import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunPhase, WorldHost } from 'cortico/core/types.ts';
import { BOOKFISH_DEFAULTS } from '../src/config.ts';
import { Library } from '../src/library.ts';
import { ReadingScheduler } from '../src/scheduler.ts';
import { FakeHost } from './helpers/fake-host.ts';

let dir: string;
let time: number;
let lib: Library;
let cfg: typeof BOOKFISH_DEFAULTS;
let host: FakeHost;
let scheduler: ReadingScheduler;
let gate: { enabled: boolean; upper: number | null };
type Deferred = Parameters<WorldHost['pushDeferred']>[0];
let queued: Deferred[];

function phase(state: RunPhase['state']) { scheduler.onRunPhase({ state, running: [], enteredAt: new Date(time).toISOString() }); }
async function advance(ms = 600000) { while (ms > 0) { const step = Math.min(ms, 5000); time += step; ms -= step; await scheduler.tick(); } }
function active() { const id = scheduler.status().active?.opportunityId; if (!id) throw new Error('expected an active opportunity'); return id; }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-voice-gate-')); time = Date.parse('2026-11-07T02:00:00Z');
  gate = { enabled: true, upper: null };
  cfg = { ...BOOKFISH_DEFAULTS, realRoutineEnabled: false, automaticReading: true, readingBatchSegments: 2, voiceOutputEnabled: true };
  lib = new Library({ dataDir: dir, now: () => time }); lib.open();
  const imported = lib.import({ filename: 'voice.txt', title: '语音门控样本', base64: Buffer.from('海边的风把故事吹长了。'.repeat(900)).toString('base64') });
  lib.select(imported.book.key); host = new FakeHost(); queued = [];
  host.pushDeferred = (event) => { queued.push(event); };
  scheduler = new ReadingScheduler(lib, cfg, 'Asia/Shanghai', () => time, () => 0.5,
    { autoAdvance: () => false, voiceGate: () => ({ ...gate }) });
  scheduler.start(host); phase('idle');
});
afterEach(() => { scheduler.stop(); lib.close(); rmSync(dir, { recursive: true, force: true }); });

describe('scheduler voice gate', () => {
  it('leaves the original scheduler untouched when voice is disabled', async () => {
    gate = { enabled: false, upper: null };
    await advance();
    expect(scheduler.status().reason).toBe('awaiting_model');
    expect(queued).toHaveLength(1);
    const id = active();
    const batch = scheduler.read(id) as { segmentId: number; segments: unknown[] };
    expect(batch.segmentId).toBe(0);
    expect(batch.segments).toHaveLength(2);
    expect(lib.status().current!.confirmedSegments).toBe(0);
  });

  it('holds automatic opportunities until the voice has fully played the batch', async () => {
    await advance();
    expect(queued).toHaveLength(0);
    expect(scheduler.status().reason).toBe('waiting_voice');
    gate.upper = 0;
    await advance();
    expect(queued).toHaveLength(0); // two segments need upper >= 1
    gate.upper = 1;
    await advance();
    expect(queued).toHaveLength(1);
    const id = active();
    const batch = scheduler.read(id) as { segments: Array<{ segmentId: number }> };
    expect(batch.segments.map(item => item.segmentId)).toEqual([0, 1]);
  });

  it('rejects manual Read now while the voice has not reached the next batch', async () => {
    gate.upper = 0;
    const key = lib.status().current!.key;
    await expect(scheduler.requestNow(key)).rejects.toThrow(/语音朗读尚未播放到下一段/);
    gate.upper = 1;
    await expect(scheduler.requestNow(key)).resolves.toMatchObject({ accepted: true });
    const id = active();
    const batch = scheduler.read(id, 2) as { segments: Array<{ segmentId: number }> };
    expect(batch.segments.map(item => item.segmentId)).toEqual([0, 1]);
  });

  it('re-checks at text issuance and leaves no pending task when the lease is stale', async () => {
    gate.upper = 3;
    const key = lib.status().current!.key;
    await scheduler.requestNow(key);
    const id = active();
    gate.upper = 0;
    expect(() => scheduler.read(id)).toThrow(/语音朗读尚未播放到下一段/);
    expect(lib.status().pending).toBeNull();
    expect(lib.status().current!.confirmedSegments).toBe(0);
  });

  it('keeps the frontier frozen across voice-gated batches and confirmation stays the only advance', async () => {
    gate.upper = 1;
    await advance(); const id = active();
    const batch = scheduler.read(id) as { segments: Array<{ taskId: string; segmentId: number }> };
    expect(lib.status().current!.confirmedSegments).toBe(0);
    const result = scheduler.finishBatch(id, batch.segments.map(item => ({ taskId: item.taskId, segmentId: item.segmentId, understanding: '' })));
    expect(result.confirmed).toBe(2);
    expect(lib.status().current!.confirmedSegments).toBe(2);
    await scheduler.tick();
    expect(scheduler.status().reason).toBe('waiting_voice');
  });
});

describe('read-only voice snapshot', () => {
  it('never creates tasks, advances progress or changes the generation', () => {
    const before = lib.status();
    const generation = lib.generation();
    const snap = lib.voiceSnapshot()!;
    expect(snap).toMatchObject({ frontier: 0, totalSegments: before.current!.totalSegments, paused: false });
    const segments = lib.voiceSegments(0, 2);
    expect(segments.map(segment => segment.id)).toEqual([0, 1]);
    expect(segments[0]!.text.length).toBeGreaterThan(0);
    expect(lib.voiceSegments(0, 99)).toHaveLength(4); // hard upper bound
    const after = lib.status();
    expect(after.pending).toBeNull();
    expect(after.current!.confirmedSegments).toBe(0);
    expect(lib.generation()).toBe(generation);
    expect(after.current!.key).toBe(before.current!.key);
    expect(lib.readingFrontier()).toBe(0);
  });

  it('returns no snapshot when no book is selected and no uncached text', () => {
    const empty = new Library({ dataDir: join(dir, 'empty') }); empty.open();
    expect(empty.voiceSnapshot()).toBeNull();
    expect(empty.voiceSegments(0, 2)).toEqual([]);
    empty.close();
  });
});
describe('terminal confirmation guard', () => {
  it('rejects an unvoiced single confirmation but keeps a committed replay idempotent', async () => {
    gate = { enabled: false, upper: null };
    await advance();
    const id = active();
    const task = scheduler.read(id, 1) as { taskId: string; segmentId: number; bookKey: string };
    expect(lib.status().current!.confirmedSegments).toBe(0);

    gate = { enabled: true, upper: null };
    expect(() => scheduler.finish({ opportunityId: id, taskId: task.taskId, segmentId: task.segmentId, understanding: '' }))
      .toThrow(/还没有被语音完整播放/);
    expect(lib.status().current!.confirmedSegments).toBe(0);

    gate = { enabled: true, upper: 0 };
    scheduler.finish({ opportunityId: id, taskId: task.taskId, segmentId: task.segmentId, understanding: '' });
    expect(lib.status().current!.confirmedSegments).toBe(1);

    gate = { enabled: true, upper: null };
    const replay = scheduler.finish({ opportunityId: id, taskId: task.taskId, segmentId: task.segmentId, understanding: '' }) as { duplicate: boolean };
    expect(replay.duplicate).toBe(true);
    expect(lib.status().current!.confirmedSegments).toBe(1);
  });

  it('rejects a batch when any uncommitted segment is beyond the voice watermark', async () => {
    gate = { enabled: false, upper: null };
    await advance();
    const id = active();
    const batch = scheduler.read(id) as { segments: Array<{ taskId: string; segmentId: number }> };
    expect(batch.segments.map(item => item.segmentId)).toEqual([0, 1]);
    gate = { enabled: true, upper: 0 };
    expect(() => scheduler.finishBatch(id, batch.segments.map(item => ({ taskId: item.taskId, segmentId: item.segmentId, understanding: '' }))))
      .toThrow(/还没有被语音完整播放/);
    expect(lib.status().current!.confirmedSegments).toBe(0);

    gate = { enabled: true, upper: 1 };
    const result = scheduler.finishBatch(id, batch.segments.map(item => ({ taskId: item.taskId, segmentId: item.segmentId, understanding: '' })));
    expect(result.confirmed).toBe(2);
    expect(lib.status().current!.confirmedSegments).toBe(2);
  });

  it('keeps original confirmations unrestricted when voice is off', async () => {
    gate = { enabled: false, upper: null };
    await advance();
    const id = active();
    const batch = scheduler.read(id) as { segments: Array<{ taskId: string; segmentId: number }> };
    const result = scheduler.finishBatch(id, batch.segments.map(item => ({ taskId: item.taskId, segmentId: item.segmentId, understanding: '' })));
    expect(result.confirmed).toBe(2);
  });
});

describe('pause clears the pending task instead of deadlocking', () => {
  it('cancels an issued but unconfirmed task on pause and leaves no pending guard after resume', () => {
    const task = lib.readNext(1);
    if (task.complete) throw new Error('expected text');
    expect(lib.voicePendingTask()).toEqual({ taskId: task.taskId, segmentId: task.segmentId });
    lib.setPaused(true);
    expect(lib.voicePendingTask()).toBeNull();
    expect(lib.status().pending).toBeNull();
    lib.setPaused(false);
    expect(lib.voicePendingTask()).toBeNull();
    expect(lib.status().pending).toBeNull();
    expect(lib.status().current!.confirmedSegments).toBe(0);
  });
});

describe('voice-paced batch (continuous read-aloud)', () => {
  it('issues exactly the already-played segment and confirms it, ignoring automaticReading', async () => {
    cfg.automaticReading = false;
    scheduler.setVoiceBatchMode(true);
    gate = { enabled: true, upper: 0 };
    const key = lib.status().current!.key;
    await expect(scheduler.requestVoiceBatch(key)).resolves.toMatchObject({ accepted: true, duplicate: false });
    const id = active();
    const batch = scheduler.read(id) as { taskId: string; segments: Array<{ segmentId: number; taskId: string }> };
    expect(batch.segments.map(segment => segment.segmentId)).toEqual([0]);
    expect(lib.status().pending).not.toBeNull();
    scheduler.finish({ opportunityId: id, taskId: batch.taskId, segmentId: 0, understanding: '' });
    expect(lib.status().current!.confirmedSegments).toBe(1);
  });

  it('does nothing until at least one segment is fully played', async () => {
    scheduler.setVoiceBatchMode(true);
    gate = { enabled: true, upper: null };
    await expect(scheduler.requestVoiceBatch(lib.status().current!.key)).resolves.toMatchObject({ accepted: false });
    expect(queued).toHaveLength(0);
  });

  it('deduplicates while a voice batch is already active', async () => {
    scheduler.setVoiceBatchMode(true);
    gate = { enabled: true, upper: 0 };
    const key = lib.status().current!.key;
    await expect(scheduler.requestVoiceBatch(key)).resolves.toMatchObject({ accepted: true, duplicate: false });
    await expect(scheduler.requestVoiceBatch(key)).resolves.toMatchObject({ accepted: true, duplicate: true });
  });

  it('suppresses timer-based automatic opportunities while in voice batch mode', async () => {
    gate = { enabled: true, upper: 5 };
    scheduler.setVoiceBatchMode(true);
    await advance();
    expect(queued).toHaveLength(0);
  });
});
