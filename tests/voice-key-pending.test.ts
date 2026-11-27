import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOOKFISH_DEFAULTS } from '../src/config.ts';
import { Library } from '../src/library.ts';
import { ReadingScheduler } from '../src/scheduler.ts';
import { VoiceCoordinator } from '../src/voice/coordinator.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { deferred, makeWav, waitFor } from './helpers/voice-fixtures.ts';

let dir: string;
let lib: Library;
let scheduler: ReadingScheduler;
let coordinator: VoiceCoordinator;
let block: ReturnType<typeof deferred>;
let plays = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-voice-key-pending-'));
  const time = Date.parse('2026-11-07T02:00:00Z');
  lib = new Library({ dataDir: dir, now: () => time }); lib.open();
  const imported = lib.import({
    filename: 'key-pending.txt', title: 'KEY水位样本',
    base64: Buffer.from('第一章 开始\n第一段短正文。\n\n第二章 继续\n第二段短正文。\n').toString('base64'),
  });
  lib.select(imported.book.key);
  expect(lib.status().current!.totalSegments).toBe(2);
  const cfg = { ...BOOKFISH_DEFAULTS, realRoutineEnabled: false, automaticReading: false, voiceOutputEnabled: true, readingBatchSegments: 1 };
  scheduler = new ReadingScheduler(lib, cfg, 'Asia/Shanghai', () => time, () => 0.5,
    { autoAdvance: () => false, voiceGate: () => coordinator.gate() });
  scheduler.start(new FakeHost());
  scheduler.onRunPhase({ state: 'idle', running: [], enteredAt: new Date(time).toISOString() });
  plays = 0; block = deferred();
  coordinator = new VoiceCoordinator({
    port: {
      snapshot: () => lib.voiceSnapshot(),
      segments: (from, max) => lib.voiceSegments(from, max),
      pendingTask: () => lib.voicePendingTask(),
    },
    enabled: () => true, secret: () => 'test-key', dataDir: dir,
    synthesize: async () => makeWav(),
    play: async (_bytes, { signal }) => {
      plays += 1;
      if (plays === 2) {
        await Promise.race([block.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
      }
    },
    pollMs: 0,
  });
  coordinator.attach();
});
afterEach(async () => {
  block.resolve(undefined);
  await coordinator.dispose();
  scheduler.stop();
  lib.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('V2.1.1 KEY change with a live pending task', () => {
  it('keeps the played watermark, allows the heard segment but blocks a later pending segment', async () => {
    await coordinator.start();
    await waitFor(() => coordinator.status().voicedUpTo === 0 && plays === 2);
    const read = lib.readNext(2);
    if (read.complete) throw new Error('expected text');
    const [heard, later] = read.segments;
    expect(heard!.segmentId).toBe(0);
    expect(later!.segmentId).toBe(1);

    await coordinator.onKeyChanged();
    expect(coordinator.status()).toMatchObject({ phase: 'idle', bookKey: lib.status().current!.key, voicedUpTo: 0 });
    expect(coordinator.gate()).toMatchObject({ enabled: true, upper: 0 });
    expect(lib.voicePendingTask()).toEqual({ taskId: heard!.taskId, segmentId: 0 });

    expect(() => scheduler.finish({ taskId: later!.taskId, bookKey: read.bookKey, segmentId: 1, understanding: '' }))
      .toThrow(/还没有被语音完整播放/);
    expect(lib.status().current!.confirmedSegments).toBe(0);

    const result = scheduler.finish({ taskId: heard!.taskId, bookKey: read.bookKey, segmentId: 0, understanding: '' });
    expect(result.duplicate).toBe(false);
    expect(lib.status().current!.confirmedSegments).toBe(1);
    expect(lib.status().pending).toMatchObject({ taskId: later!.taskId, segmentId: 1 });
  });
});