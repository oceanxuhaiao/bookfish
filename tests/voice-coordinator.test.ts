import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceCoordinator } from '../src/voice/coordinator.ts';
import type { VoiceBookSnapshot } from '../src/voice/types.ts';
import { deferred, makeWav, waitFor, type Deferred } from './helpers/voice-fixtures.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bookfish-voice-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface HarnessOptions {
  enabled?: boolean;
  key?: string;
  synth?: (text: string, signal: AbortSignal) => Promise<Uint8Array>;
  play?: (bytes: Uint8Array, options: { tempDir: string; signal: AbortSignal }) => Promise<unknown>;
  pendingTask?: () => { taskId: string; segmentId: number } | null;
  pendingTasks?: () => Array<{ taskId: string; bookKey: string; segmentId: number; generation: number; expiresAt: number }>;
  onSnapshot?: () => void;
  pollMs?: number;
  shouldInterruptForChat?: () => boolean;
  fetchNext?: (signal: AbortSignal) => Promise<void>;
}

function harness(texts: string[], options: HarnessOptions = {}) {
  const state: VoiceBookSnapshot = {
    bookKey: 'book:1', title: '测试书', generation: 1, frontier: 0,
    totalSegments: texts.length, paused: false, complete: false, readiness: 'backlog',
  };
  const synthCalls: string[] = [];
  const played: number[] = [];
  let enabled = options.enabled ?? true;
  const synth = options.synth ?? (async () => makeWav());
  const play = options.play ?? (async () => { played.push(1); });
  const coordinator = new VoiceCoordinator({
    port: {
      snapshot: () => { options.onSnapshot?.(); return { ...state }; },
      segments: (from, max) => texts.slice(from, from + max).map((text, index) => ({ id: from + index, text })),
      pendingTask: options.pendingTask,
      pendingTasks: options.pendingTasks,
    },
    enabled: () => enabled,
    secret: () => options.key ?? 'test-key',
    dataDir: dir,
    synthesize: (text, signal) => { synthCalls.push(text); return synth(text, signal); },
    play: (bytes, opts) => play(bytes, opts),
    pollMs: options.pollMs ?? 0,
    shouldInterruptForChat: options.shouldInterruptForChat,
    fetchNext: options.fetchNext,
  });
  coordinator.attach();
  return { state, texts, coordinator, synthCalls, played,
    setEnabled(value: boolean) { enabled = value; } };
}

describe('voice coordinator lifecycle', () => {
  it('plays cached segments in order and exposes the contiguous watermark', async () => {
    const h = harness(['第一段。', '第二段。', '第三段。']);
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 2);
    expect(h.synthCalls.join('')).toBe('第一段。第二段。第三段。');
    expect(h.coordinator.status()).toMatchObject({ phase: 'waiting_content', totalSegments: 3 });
    expect(h.coordinator.gate()).toMatchObject({ enabled: true, upper: 2 });
    expect(h.state.frontier).toBe(0);
    await h.coordinator.dispose();
  });

  it('treats an empty segment as passed without synthesis', async () => {
    const h = harness(['', '有字。']);
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 1);
    expect(h.synthCalls).toEqual(['有字。']);
    await h.coordinator.dispose();
  });

  it('treats a repeated start as idempotent while playing', async () => {
    const block = deferred();
    const h = harness(['甲。', '乙。'], {
      play: async (_bytes, { signal }) => {
        await Promise.race([block.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
      },
    });
    const first = await h.coordinator.start();
    const second = await h.coordinator.start();
    expect(second.phase).toBe(first.phase);
    expect(h.synthCalls.length).toBeLessThanOrEqual(2);
    await h.coordinator.stop('user');
    block.resolve();
    await h.coordinator.dispose();
  });

  it('reports a playback failure and keeps the completed prefix', async () => {
    let calls = 0;
    const h = harness(['甲。', '乙。'], {
      play: async () => {
        calls += 1;
        if (calls === 2) throw new Error('播放器失败');
      },
    });
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().phase === 'error');
    expect(h.coordinator.status().error).toContain('播放器失败');
    expect(h.coordinator.status().voicedUpTo).toBe(0);
    await h.coordinator.dispose();
  });

  it('stops when the library closes while a task is still playing', async () => {
    let closed = false;
    const texts = ['甲。', '乙。'];
    const port = {
      snapshot: () => {
        if (closed) throw new Error('Bookfish library is not mounted');
        return { bookKey: 'book:1', title: '测试书', generation: 1, frontier: 0, totalSegments: 2, paused: false, complete: false, readiness: 'backlog' };
      },
      segments: (from: number, max: number) => texts.slice(from, from + max).map((text, index) => ({ id: from + index, text })),
    };
    const coordinator = new VoiceCoordinator({ port, enabled: () => true, secret: () => 'test-key', dataDir: dir,
      synthesize: async () => makeWav(), play: async (_bytes, { signal }) => {
        await Promise.race([new Promise<void>(resolve => setTimeout(resolve, 5000)), new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
      }, pollMs: 0 });
    coordinator.attach();
    await coordinator.start();
    await waitFor(() => coordinator.status().phase === 'playing');
    closed = true;
    await coordinator.revalidate();
    expect(coordinator.status()).toMatchObject({ phase: 'idle', bookKey: null, voicedUpTo: null });
    await coordinator.dispose();
  });

  it('chat priority stops playback, keeps completed segments and never marks the interrupted one', async () => {
    let playCount = 0;
    const block = deferred();
    const h = harness(['第一段。', '第二段。'], {
      play: async (_bytes, { signal }) => {
        playCount += 1;
        if (playCount === 2) {
          await Promise.race([block.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
        }
      },
    });
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 0 && playCount === 2);
    h.coordinator.onRunPhase({ state: 'model' });
    await waitFor(() => h.coordinator.status().phase === 'paused');
    expect(h.coordinator.status().voicedUpTo).toBe(0);
    expect(h.coordinator.gate().upper).toBe(0);
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 1);
    expect(h.synthCalls.at(-1)).toBe('第二段。');
    await h.coordinator.dispose();
  });

  it('drops a late synthesis result after stop', async () => {
    const slow = deferred<Uint8Array>();
    const h = harness(['慢段落。'], { synth: () => slow.promise });
    await h.coordinator.start();
    await waitFor(() => h.synthCalls.length === 1);
    const stopping = h.coordinator.stop('user');
    slow.resolve(makeWav());
    await stopping;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(h.played).toHaveLength(0);
    expect(h.coordinator.status().phase).toBe('idle');
    expect(h.coordinator.gate().upper).toBeNull();
    await h.coordinator.dispose();
  });

  it('serializes rapid stop and restart without two concurrent players', async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const h = harness(['一段。', '二段。', '三段。'], {
      synth: async (text) => { h.synthCalls.push(text); await new Promise(resolve => setTimeout(resolve, 15)); return makeWav(); },
      play: async () => {
        calls += 1; active += 1; maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 15));
        active -= 1;
      },
    });
    await h.coordinator.start();
    await h.coordinator.stop('user');
    await h.coordinator.start();
    await waitFor(() => calls >= 1);
    await h.coordinator.stop('user');
    await waitFor(() => h.coordinator.status().phase === 'paused' || h.coordinator.status().phase === 'idle');
    expect(maxActive).toBe(1);
    await h.coordinator.dispose();
  });

  it('switching book or pausing clears the session and watermark', async () => {
    const h = harness(['甲。', '乙。', '丙。']);
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo !== null);
    h.state.bookKey = 'book:2'; h.state.generation = 2;
    await h.coordinator.revalidate();
    expect(h.coordinator.status()).toMatchObject({ phase: 'idle', bookKey: null, voicedUpTo: null });
    expect(h.coordinator.gate().upper).toBeNull();
    await h.coordinator.dispose();
  });

  it('pause clears the session and watermark as well', async () => {
    const h = harness(['甲。', '乙。']);
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo !== null);
    h.state.paused = true;
    await h.coordinator.revalidate();
    expect(h.coordinator.status().voicedUpTo).toBeNull();
    expect(h.coordinator.status().phase).toBe('idle');
    await h.coordinator.dispose();
  });

  it('reports a TTS failure and keeps the fully voiced prefix', async () => {
    const h = harness(['甲。', '乙。'], {
      synth: async (text) => { h.synthCalls.push(text); if (text === '乙。') throw new Error('合成失败'); return makeWav(); },
    });
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().phase === 'error');
    expect(h.coordinator.status().error).toContain('合成失败');
    expect(h.coordinator.status().voicedUpTo).toBe(0);
    expect(h.coordinator.gate().upper).toBe(0);
    await h.coordinator.dispose();
  });

  it('waits at a cached end and resumes when new chapters appear', async () => {
    const h = harness(['甲。', '乙。']);
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().phase === 'waiting_content');
    expect(h.coordinator.status().voicedUpTo).toBe(1);
    h.texts.push('丙。', '丁。'); h.state.totalSegments = 4;
    await h.coordinator.revalidate();
    await waitFor(() => h.coordinator.status().voicedUpTo === 3);
    await h.coordinator.dispose();
  });

  it('asks the World source flow once for the next remote chapter', async () => {
    const h = harness(['甲。']);
    let fetches = 0;
    let appended = false;
    const coordinator = new VoiceCoordinator({
      port: { snapshot: () => ({ ...h.state }), segments: (from, max) => h.texts.slice(from, from + max).map((text, index) => ({ id: from + index, text })) },
      enabled: () => true, secret: () => 'test-key', dataDir: dir,
      fetchNext: async () => { fetches += 1; if (!appended) { appended = true; h.texts.push('乙。'); h.state.totalSegments = 2; } },
      synthesize: async text => { h.synthCalls.push(text); return makeWav(); },
      play: async () => { h.played.push(1); }, pollMs: 0,
    });
    coordinator.attach();
    await coordinator.start();
    await waitFor(() => coordinator.status().voicedUpTo === 1);
    expect(fetches).toBeGreaterThanOrEqual(1);
    expect(h.texts).toHaveLength(2);
    await coordinator.dispose();
  });

  it('bounds prefetch to one prepared chunk', async () => {
    const block = deferred();
    const h = harness(['甲。', '乙。', '丙。'], {
      play: async (_bytes, { signal }) => {
        await Promise.race([block.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
      },
    });
    await h.coordinator.start();
    await waitFor(() => h.synthCalls.length >= 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(h.synthCalls.length).toBeLessThanOrEqual(2);
    await h.coordinator.stop('user');
    block.resolve();
    await h.coordinator.dispose();
  });

  it('clears the watermark when the setting is turned off but keeps it across a key change', async () => {
    const h = harness(['甲。', '乙。']);
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo !== null);
    h.setEnabled(false);
    await h.coordinator.revalidate();
    expect(h.coordinator.status().phase).toBe('disabled');
    expect(h.coordinator.gate()).toMatchObject({ enabled: false, upper: null });
    h.setEnabled(true);
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo !== null);
    const watermark = h.coordinator.status().voicedUpTo;
    await h.coordinator.onKeyChanged();
    expect(h.coordinator.status()).toMatchObject({ phase: 'idle', bookKey: 'book:1', voicedUpTo: watermark });
    expect(h.coordinator.gate()).toMatchObject({ enabled: true, upper: watermark });
    await h.coordinator.dispose();
  });

  it('removes leftover audio files on start and dispose', async () => {
    const temp = join(dir, 'bookfish', 'voice-tmp');
    const h = harness(['甲。']);
    rmSync(temp, { recursive: true, force: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(temp, { recursive: true });
    writeFileSync(join(temp, 'stale.wav'), makeWav());
    await h.coordinator.start();
    expect(readdirSync(temp).filter(name => name.endsWith('.wav'))).toHaveLength(0);
    writeFileSync(join(temp, 'again.wav'), makeWav());
    await h.coordinator.dispose();
    expect(readdirSync(temp).filter(name => name.endsWith('.wav'))).toHaveLength(0);
  });
});
describe('voice start boundary and timer lifecycle', () => {
  it('refuses an unvoiced pending task but allows one already covered by the watermark', async () => {
    let pending: { taskId: string; segmentId: number } | null = { taskId: 't0', segmentId: 0 };
    const h = harness(['甲。', '乙。'], { pendingTask: () => pending });
    await expect(h.coordinator.start()).rejects.toThrow(/未完成的阅读任务/);
    pending = null;
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo !== null);
    await h.coordinator.stop('user');
    expect(h.coordinator.status().voicedUpTo).not.toBeNull();
    pending = { taskId: 't0', segmentId: 0 };
    await expect(h.coordinator.start()).resolves.toMatchObject({ phase: 'playing' });
    await h.coordinator.dispose();
  });

  it('stops periodic revalidation after user stop and restarts it on the next start', async () => {
    let snapshots = 0;
    const block = deferred();
    const h = harness(['甲。', '乙。'], {
      pollMs: 10,
      onSnapshot: () => { snapshots += 1; },
      play: async (_bytes, { signal }) => {
        await Promise.race([block.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
      },
    });
    await h.coordinator.start();
    await waitFor(() => snapshots > 0);
    await h.coordinator.stop('user');
    const stoppedAt = snapshots;
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(snapshots - stoppedAt).toBeLessThanOrEqual(2);
    await h.coordinator.start();
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(snapshots).toBeGreaterThan(stoppedAt + 2);
    block.resolve();
    await h.coordinator.dispose();
  });

  it('stops periodic revalidation after an error', async () => {
    let snapshots = 0;
    const h = harness(['甲。'], {
      pollMs: 10,
      onSnapshot: () => { snapshots += 1; },
      synth: async () => { throw new Error('合成失败'); },
    });
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().phase === 'error');
    const stoppedAt = snapshots;
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(snapshots - stoppedAt).toBeLessThanOrEqual(2);
    await h.coordinator.dispose();
  });

  it('keeps bounded revalidation while waiting for later text', async () => {
    let snapshots = 0;
    const h = harness(['甲。'], { pollMs: 10, onSnapshot: () => { snapshots += 1; } });
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().phase === 'waiting_content');
    const waitingAt = snapshots;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(snapshots).toBeGreaterThan(waitingAt + 2);
    await h.coordinator.dispose();
  });
});

describe('completion and pause boundaries', () => {
  it('leaves waiting_content for idle when the book becomes complete', async () => {
    const h = harness(['最后一段。'], { pollMs: 0 });
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().phase === 'waiting_content');
    h.state.complete = true;
    await h.coordinator.revalidate();
    expect(h.coordinator.status()).toMatchObject({ phase: 'idle', detail: '本书已读完。' });
    await expect(h.coordinator.start()).rejects.toThrow(/读完了/);
    await h.coordinator.dispose();
  });
});

describe('chat safety net without a new phase callback', () => {
  it('stops within a bounded poll when a user event arrives mid-turn', async () => {
    let interrupt = false;
    const block = deferred();
    const h = harness(['甲。', '乙。'], {
      pollMs: 10,
      shouldInterruptForChat: () => interrupt,
      play: async (_bytes, { signal }) => {
        await Promise.race([block.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
      },
    });
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().phase === 'playing');
    interrupt = true;
    await waitFor(() => (h.coordinator.status().phase === 'paused' || h.coordinator.status().phase === 'idle')
      && (h.coordinator.status().detail ?? '').includes('聊天优先'));
    expect(h.coordinator.status().detail).toContain('聊天优先');
    block.resolve();
    await h.coordinator.dispose();
  });
});

describe('V2.1.1 waiting_content chat priority', () => {
  it('stops waiting playback, ignores new text until the user starts again', async () => {
    let interrupt = false;
    let snapshots = 0;
    const h = harness(['甲。'], { pollMs: 10, shouldInterruptForChat: () => interrupt, onSnapshot: () => { snapshots += 1; } });
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().phase === 'waiting_content');
    interrupt = true;
    h.coordinator.onRunPhase({ state: 'model' });
    await waitFor(() => (h.coordinator.status().phase === 'paused' || h.coordinator.status().phase === 'idle')
      && (h.coordinator.status().detail ?? '').includes('聊天优先'));

    const watermark = h.coordinator.status().voicedUpTo;
    const stoppedAt = snapshots;
    h.texts.push('丙。'); h.state.totalSegments = 2;
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(snapshots - stoppedAt).toBeLessThanOrEqual(2);
    expect(h.coordinator.status().phase === 'paused' || h.coordinator.status().phase === 'idle').toBe(true);
    expect(h.coordinator.status().voicedUpTo).toBe(watermark);
    expect(h.synthCalls).not.toContain('丙。');
    await expect(h.coordinator.start()).rejects.toThrow(/优先处理当前对话/);

    interrupt = false;
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 1);
    expect(h.synthCalls).toContain('丙。');
    await h.coordinator.dispose();
  });

  it('rejects a manual start while the user chat is still active', async () => {
    let interrupt = true;
    const h = harness(['甲。'], { shouldInterruptForChat: () => interrupt });
    await expect(h.coordinator.start()).rejects.toThrow(/优先处理当前对话/);
    interrupt = false;
    await expect(h.coordinator.start()).resolves.toMatchObject({ phase: 'playing' });
    await h.coordinator.dispose();
  });

  it('drops a late synthesis result after a chat stop', async () => {
    const slow = deferred<Uint8Array>();
    const h = harness(['慢段。'], { synth: () => slow.promise });
    await h.coordinator.start();
    await waitFor(() => h.synthCalls.length === 1);
    h.coordinator.onRunPhase({ state: 'model' });
    slow.resolve(makeWav());
    await waitFor(() => h.coordinator.status().phase === 'idle' || h.coordinator.status().phase === 'paused');
    expect(h.played).toHaveLength(0);
    expect(h.coordinator.status().voicedUpTo).toBeNull();
    await h.coordinator.dispose();
  });
});

describe('V2.1.1 KEY change keeps the played watermark', () => {
  it('keeps the completed prefix and resumes after the interrupted segment', async () => {
    let plays = 0;
    const block = deferred();
    const h = harness(['甲。', '乙。', '丙。'], {
      play: async (_bytes, { signal }) => {
        plays += 1;
        if (plays === 2) {
          await Promise.race([block.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
        }
      },
    });
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 0 && plays === 2);
    await h.coordinator.onKeyChanged();
    expect(h.coordinator.status()).toMatchObject({ phase: 'idle', bookKey: 'book:1', voicedUpTo: 0 });
    expect(h.coordinator.gate()).toMatchObject({ enabled: true, upper: 0 });

    // Saving a replacement KEY calls the same hook again and must not clear it.
    await h.coordinator.onKeyChanged();
    expect(h.coordinator.status().voicedUpTo).toBe(0);
    block.resolve();
    await h.coordinator.start();
    await waitFor(() => (h.coordinator.status().voicedUpTo ?? -1) >= 1);
    expect(h.synthCalls.filter(text => text === '甲。')).toHaveLength(1);
    expect(h.synthCalls.filter(text => text === '乙。').length).toBeGreaterThanOrEqual(2);
    await h.coordinator.dispose();
  });

  it('does not inherit the watermark after a book or generation change', async () => {
    const h = harness(['甲。', '乙。']);
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo !== null);
    h.state.bookKey = 'book:2'; h.state.generation = 2;
    await h.coordinator.onKeyChanged();
    expect(h.coordinator.status()).toMatchObject({ phase: 'idle', bookKey: null, voicedUpTo: null });
    expect(h.coordinator.gate()).toMatchObject({ enabled: true, upper: null });
    await h.coordinator.dispose();
  });
});

describe('V2.1.1 late chapter fetch after chat', () => {
  it('does not restart after a late fetch resolves', async () => {
    const fetchStarted = deferred();
    const gate = deferred();
    let interrupt = false;
    const h = harness(['甲。'], {
      pollMs: 10,
      shouldInterruptForChat: () => interrupt,
      fetchNext: async (signal) => {
        fetchStarted.resolve();
        await Promise.race([gate.promise, new Promise<void>((_, reject) => {
          if (signal.aborted) { reject(new Error('aborted')); return; }
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })]);
      },
    });
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 0);
    await fetchStarted.promise;
    interrupt = true;
    h.coordinator.onRunPhase({ state: 'model' });
    await waitFor(() => (h.coordinator.status().phase === 'paused' || h.coordinator.status().phase === 'idle')
      && (h.coordinator.status().detail ?? '').includes('聊天优先'));
    h.texts.push('乙。'); h.state.totalSegments = 2;
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(h.coordinator.status().voicedUpTo).toBe(0);
    expect(h.synthCalls).not.toContain('乙。');
    interrupt = false;
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 1);
    expect(h.synthCalls).toContain('乙。');
    await h.coordinator.dispose();
  });
});

describe('V2.1.1 linked chat + KEY + new chapter', () => {
  it('never auto-resumes; only an explicit start continues', async () => {
    let interrupt = false;
    let plays = 0;
    const block = deferred();
    const h = harness(['甲。', '乙。'], {
      pollMs: 10,
      shouldInterruptForChat: () => interrupt,
      play: async (_bytes, { signal }) => {
        plays += 1;
        if (plays === 2) {
          await Promise.race([block.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
        }
      },
    });
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 0 && plays === 2);
    interrupt = true;
    h.coordinator.onRunPhase({ state: 'model' });
    await waitFor(() => (h.coordinator.status().phase === 'paused' || h.coordinator.status().phase === 'idle')
      && (h.coordinator.status().detail ?? '').includes('聊天优先'));
    const watermark = h.coordinator.status().voicedUpTo;
    await h.coordinator.onKeyChanged();
    expect(h.coordinator.status().voicedUpTo).toBe(watermark);
    h.texts.push('丙。'); h.state.totalSegments = 3;
    interrupt = false;
    await h.coordinator.revalidate();
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(h.coordinator.status().phase).not.toBe('playing');
    expect(h.synthCalls).not.toContain('丙。');
    block.resolve();
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo !== null && h.synthCalls.includes('丙。'));
    await h.coordinator.dispose();
  });
});

describe('V2.1.2 KEY recovery identity checks', () => {
  function keyedHarness(segments: string[], pendingRef: { current: Array<{ taskId: string; bookKey: string; segmentId: number; generation: number; expiresAt: number }> }) {
    let plays = 0;
    const block = deferred();
    const h = harness(segments, {
      pendingTasks: () => pendingRef.current,
      play: async (_bytes, { signal }) => {
        plays += 1;
        if (plays === 2) {
          await Promise.race([block.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
        }
      },
    });
    return { h, block };
  }

  it('rejects a pending task that is not exactly the next segment', async () => {
    const pending = { current: [] as Array<{ taskId: string; bookKey: string; segmentId: number; generation: number; expiresAt: number }> };
    const { h, block } = keyedHarness(['甲。', '乙。', '丙。'], pending);
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 0);
    await h.coordinator.onKeyChanged();
    pending.current = [{ taskId: 'gap', bookKey: 'book:1', segmentId: 2, generation: 1, expiresAt: Date.now() + 60_000 }];
    await expect(h.coordinator.start()).rejects.toThrow(/不是已朗读水位之后的下一段/);
    block.resolve();
    await h.coordinator.dispose();
  });

  it('rejects a pending task from another book', async () => {
    const pending = { current: [] as Array<{ taskId: string; bookKey: string; segmentId: number; generation: number; expiresAt: number }> };
    const { h, block } = keyedHarness(['甲。', '乙。'], pending);
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 0);
    await h.coordinator.onKeyChanged();
    pending.current = [{ taskId: 'other', bookKey: 'book:9', segmentId: 1, generation: 1, expiresAt: Date.now() + 60_000 }];
    await expect(h.coordinator.start()).rejects.toThrow(/其他书籍或正文版本/);
    block.resolve();
    await h.coordinator.dispose();
  });

  it('ignores an expired task instead of blocking start forever', async () => {
    const pending = { current: [] as Array<{ taskId: string; bookKey: string; segmentId: number; generation: number; expiresAt: number }> };
    const { h, block } = keyedHarness(['甲。', '乙。'], pending);
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 0);
    await h.coordinator.onKeyChanged();
    pending.current = [{ taskId: 'old', bookKey: 'book:1', segmentId: 1, generation: 1, expiresAt: Date.now() - 1 }];
    block.resolve();
    await expect(h.coordinator.start()).resolves.toMatchObject({ phase: 'playing' });
    await waitFor(() => h.coordinator.status().voicedUpTo === 1);
    await h.coordinator.dispose();
  });

  it('does not inherit the watermark when generation changes after the KEY stop', async () => {
    const pending = { current: [] as Array<{ taskId: string; bookKey: string; segmentId: number; generation: number; expiresAt: number }> };
    const { h, block } = keyedHarness(['甲。', '乙。'], pending);
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 0);
    await h.coordinator.onKeyChanged();
    h.state.generation = 2;
    block.resolve();
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo !== null);
    expect(h.synthCalls.filter(text => text === '甲。').length).toBeGreaterThanOrEqual(2);
    await h.coordinator.dispose();
  });

  it('does not inherit the watermark when the book changes after the KEY stop', async () => {
    const pending = { current: [] as Array<{ taskId: string; bookKey: string; segmentId: number; generation: number; expiresAt: number }> };
    const { h, block } = keyedHarness(['甲。', '乙。'], pending);
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 0);
    await h.coordinator.onKeyChanged();
    h.state.bookKey = 'book:2';
    block.resolve();
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo !== null);
    expect(h.synthCalls.filter(text => text === '甲。').length).toBeGreaterThanOrEqual(2);
    await h.coordinator.dispose();
  });

  it('rebuilds the session when the old watermark exceeds the current text', async () => {
    const pending = { current: [] as Array<{ taskId: string; bookKey: string; segmentId: number; generation: number; expiresAt: number }> };
    const h = harness(['甲。', '乙。'], { pendingTasks: () => pending.current });
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 1);
    await h.coordinator.onKeyChanged();
    h.state.totalSegments = 1;
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 0);
    expect(h.synthCalls.filter(text => text === '甲。').length).toBeGreaterThanOrEqual(2);
    await h.coordinator.dispose();
  });
});

describe('V2.1.2 generation change with old pending metadata', () => {
  it('does not reuse a pending task from the old generation', async () => {
    const pending = { current: [{ taskId: 'old-gen', bookKey: 'book:1', segmentId: 1, generation: 1, expiresAt: Date.now() + 60_000 }] };
    const h = harness(['甲。', '乙。'], { pendingTasks: () => pending.current });
    h.state.generation = 2;
    await expect(h.coordinator.start()).rejects.toThrow(/其他书籍或正文版本/);
    await h.coordinator.dispose();
  });

  it('invalidates a recovered session when generation changes afterwards', async () => {
    let plays = 0;
    const block = deferred();
    const h = harness(['甲。', '乙。'], {
      play: async (_bytes, { signal }) => {
        plays += 1;
        if (plays === 2) {
          await Promise.race([block.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
        }
      },
    });
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 0);
    await h.coordinator.onKeyChanged();
    block.resolve();
    await h.coordinator.start();
    await waitFor(() => h.coordinator.status().voicedUpTo === 1);
    h.state.generation = 2;
    await h.coordinator.revalidate();
    expect(h.coordinator.status()).toMatchObject({ phase: 'idle', bookKey: null, voicedUpTo: null });
    await h.coordinator.dispose();
  });
});
