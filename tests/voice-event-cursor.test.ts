import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope, WorldHost } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BOOKFISH } from '../src/definition.ts';
import { BookfishWorld } from '../src/world.ts';
import type { VoicePlaybackEngine, VoiceStatus } from '../src/voice/types.ts';
import { FakeHost } from './helpers/fake-host.ts';

let scratchDir: string;

class MutableStore {
  cursor = 0;
  events: EventEnvelope[] = [];
  fail = false;
  afterRange: (() => void) | null = null;
  addExternal(text = '用户消息'): EventEnvelope {
    this.cursor += 1;
    const event = { cursor: this.cursor, type: 'core.user', ts: new Date().toISOString(),
      source: 'core', origin: 'external', text } as EventEnvelope;
    this.events.push(event);
    return event;
  }
  latestCursor() { return this.cursor; }
  get(cursor: number) { return this.events.find(event => event.cursor === cursor); }
  range(q: { fromCursor?: number; toCursor?: number; origin?: string; source?: string; senderKey?: string; limit?: number }) {
    if (this.fail) throw new Error('store unavailable');
    const from = q.fromCursor ?? 0;
    const to = q.toCursor ?? this.cursor;
    let list = this.events.filter(event => event.cursor >= from && event.cursor <= to
      && (!q.origin || event.origin === q.origin)
      && (!q.source || event.source === q.source)
      && (!q.senderKey || event.senderKey === q.senderKey));
    if (q.limit !== undefined) list = list.slice(-q.limit);
    this.afterRange?.();
    return list;
  }
  around(cursor: number, before: number, after: number) {
    return this.events.filter(event => event.cursor >= cursor - before && event.cursor <= cursor + after);
  }
  grep() { return []; }
}

function fakeEngine(): VoicePlaybackEngine & { calls: string[] } {
  const calls: string[] = [];
  const status = (): VoiceStatus => ({ enabled: true, phase: 'idle', bookKey: null, title: null, segmentId: null,
    voicedUpTo: null, totalSegments: null, keyConfigured: true, error: null, detail: null });
  return {
    calls,
    attach: vi.fn(() => { calls.push('attach'); }),
    start: vi.fn(async () => { calls.push('start'); return status(); }),
    stop: vi.fn(async () => { calls.push('stop'); }),
    status,
    gate: () => ({ enabled: false, upper: null, bookKey: null, generation: null }),
    onRunPhase: vi.fn(() => { calls.push('phase'); }),
    revalidate: vi.fn(async () => { calls.push('revalidate'); }),
    onConfigChanged: vi.fn(async () => { calls.push('config'); }),
    onKeyChanged: vi.fn(async () => { calls.push('key'); }),
    shutdown: vi.fn(async () => { calls.push('shutdown'); }),
    dispose: vi.fn(async () => {}),
  };
}

async function setup() {
  const ctx = fakeWorldContext(BOOKFISH, { scratchDir });
  ctx.persist({ automaticReading: false, realRoutineEnabled: false, readingBatchSegments: 1 });
  const engine = fakeEngine();
  const world = new BookfishWorld({
    cfg: ctx.cfg, timezone: ctx.timezone, dataDir: ctx.dataDir,
    persist: patch => ctx.persist(patch),
    secret: () => '', storeSecret: () => {}, botDir: ctx.botDir, voice: engine,
  });
  const host = new FakeHost();
  const store = new MutableStore();
  (host as unknown as { store: MutableStore }).store = store;
  await world.start(host);
  const invoke = world.webUi!('zh').invoke!;
  const imported = await invoke('status', 'import', [{ filename: 'events.txt', title: '事件游标样本',
    base64: Buffer.from('第一章 开始\n第一段正文。\n\n第二章 继续\n第二段正文。\n').toString('base64') }]) as { book: { key: string } };
  await invoke('status', 'select', [imported.book.key]);
  await invoke('status', 'read_now', [imported.book.key]);
  ctx.persist({ voiceOutputEnabled: true });
  return { ctx, world, engine, host, store, invoke };
}

beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'bookfish-voice-events-')); });
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

describe('V2.1.1 external event cursor state', () => {
  it('does not lose an event stored before idle and consumes it after the chat turn', async () => {
    const { world, engine, store } = await setup();
    try {
      store.addExternal();
      world.onRunPhase!({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
      engine.calls.length = 0;
      world.onRunPhase!({ state: 'model', running: [], enteredAt: new Date().toISOString() });
      expect(engine.calls).toContain('phase');

      world.onRunPhase!({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
      engine.calls.length = 0;
      world.onRunPhase!({ state: 'model', running: [], enteredAt: new Date().toISOString() });
      expect(engine.calls).not.toContain('phase');
    } finally { await world.stop(); }
  });

  it('finds an event inserted between latestCursor and range', async () => {
    const { world, engine, store } = await setup();
    try {
      store.cursor = 1; // a snapshot with no external event
      let injected = false;
      store.afterRange = () => { if (!injected) { injected = true; store.addExternal('扫描期间到达'); } };
      world.onRunPhase!({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
      engine.calls.length = 0;
      world.onRunPhase!({ state: 'model', running: [], enteredAt: new Date().toISOString() });
      expect(engine.calls).toContain('phase');
    } finally { await world.stop(); }
  });

  it('treats a failed scan as chat and does not advance the cursor', async () => {
    const { world, engine, store } = await setup();
    try {
      store.cursor = 1; store.fail = true;
      world.onRunPhase!({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
      engine.calls.length = 0;
      world.onRunPhase!({ state: 'model', running: [], enteredAt: new Date().toISOString() });
      expect(engine.calls).toContain('phase');
    } finally { await world.stop(); }
  });

  it('repeated idles keep pending evidence and still release after one chat turn', async () => {
    const { world, engine, store } = await setup();
    try {
      store.addExternal();
      world.onRunPhase!({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
      world.onRunPhase!({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
      world.onRunPhase!({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
      engine.calls.length = 0;
      world.onRunPhase!({ state: 'model', running: [], enteredAt: new Date().toISOString() });
      expect(engine.calls).toContain('phase');

      world.onRunPhase!({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
      engine.calls.length = 0;
      world.onRunPhase!({ state: 'model', running: [], enteredAt: new Date().toISOString() });
      expect(engine.calls).not.toContain('phase');
    } finally { await world.stop(); }
  });

  it('does not stop normal own reading when no external event exists', async () => {
    const { world, engine } = await setup();
    try {
      world.onRunPhase!({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
      engine.calls.length = 0;
      world.onRunPhase!({ state: 'model', running: [], enteredAt: new Date().toISOString() });
      expect(engine.calls).not.toContain('phase');
    } finally { await world.stop(); }
  });
});
describe('V2.1.1 events arriving after a turn started', () => {
  it('keeps them pending for the next turn instead of consuming them at idle', async () => {
    const { world, engine, store } = await setup();
    try {
      store.addExternal('第一条用户消息');
      world.onRunPhase!({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
      world.onRunPhase!({ state: 'model', running: [], enteredAt: new Date().toISOString() });
      expect(engine.calls).toContain('phase');

      store.addExternal('本轮开始后到达');
      world.onRunPhase!({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
      engine.calls.length = 0;
      world.onRunPhase!({ state: 'model', running: [], enteredAt: new Date().toISOString() });
      expect(engine.calls).toContain('phase');

      world.onRunPhase!({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
      engine.calls.length = 0;
      world.onRunPhase!({ state: 'model', running: [], enteredAt: new Date().toISOString() });
      expect(engine.calls).not.toContain('phase');
    } finally { await world.stop(); }
  });
});
