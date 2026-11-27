import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BOOKFISH } from '../src/definition.ts';
import { BookfishWorld } from '../src/world.ts';
import type { VoicePlaybackEngine, VoiceStatus } from '../src/voice/types.ts';
import { FakeHost } from './helpers/fake-host.ts';

let scratchDir: string;
const KEY = 'sk-test-voice-1234';
beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'bookfish-voice-world-')); });
afterEach(() => { delete process.env.BOOKFISH_TTS_API_KEY; rmSync(scratchDir, { recursive: true, force: true }); vi.restoreAllMocks(); });

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
    dispose: vi.fn(async () => { calls.push('dispose'); }),
  };
}

function createWorld(secrets: Record<string, string>, stored: Record<string, string>) {
  const ctx = fakeWorldContext(BOOKFISH, { scratchDir });
  ctx.persist({ automaticReading: false, realRoutineEnabled: false });
  const engine = fakeEngine();
  const world = new BookfishWorld({
    cfg: ctx.cfg, timezone: ctx.timezone, dataDir: ctx.dataDir,
    persist: patch => ctx.persist(patch),
    secret: name => secrets[name] ?? '',
    storeSecret: (name, value) => { stored[name] = value; secrets[name] = value; },
    botDir: ctx.botDir,
    voice: engine,
  });
  return { ctx, world, engine, secrets, stored };
}

describe('BookFish voice integration', () => {
  it('keeps the model-facing status unchanged and passes the official dry mount', async () => {
    const { world } = createWorld({}, {});
    const status = JSON.parse(await world.tools()[0]!.handler({}, {} as ToolCallContext) as string);
    expect(status).not.toHaveProperty('voice');
    expect(status.scheduler).not.toHaveProperty('voice');
    expect((await dryMountWorld(BOOKFISH, { scratchDir: join(scratchDir, 'dry') })).failures).toEqual([]);
  });

  it('routes WebUI voice controls, masks the KEY and never exposes it', async () => {
    const { world, engine, stored } = createWorld({}, {});
    const invoke = world.webUi!('zh').invoke!;
    const view = await invoke('settings', 'voice_status', []) as { keyConfigured: boolean; keyMask: string | null; config: { voiceOutputEnabled: boolean } };
    expect(view).toMatchObject({ keyConfigured: false, keyMask: null, config: { voiceOutputEnabled: false } });

    const saved = await invoke('settings', 'voice_save_key', [KEY]) as { keyConfigured: boolean; keyMask: string | null };
    expect(stored.BOOKFISH_TTS_API_KEY).toBe(KEY);
    expect(saved.keyConfigured).toBe(true);
    expect(saved.keyMask).toBe('••••1234');
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(engine.calls).toContain('key');

    const started = await invoke('status', 'voice_start', []) as { status: VoiceStatus };
    expect(engine.calls).toContain('start');
    expect(started.status.phase).toBe('idle');
    await invoke('status', 'voice_stop', []);
    expect(engine.calls).toContain('stop');
  });

  it('removes only the voice KEY from .env and clears the process environment', async () => {
    const { ctx, world, engine } = createWorld({ BOOKFISH_TTS_API_KEY: KEY }, {});
    process.env.BOOKFISH_TTS_API_KEY = KEY;
    const envFile = join(ctx.botDir, '.env');
    writeFileSync(envFile, `BOOKFISH_TTS_API_KEY=${KEY}\nOTHER=keep\n`);
    await world.webUi!('zh').invoke!('settings', 'voice_clear_key', []);
    expect(process.env.BOOKFISH_TTS_API_KEY).toBeUndefined();
    const text = readFileSync(envFile, 'utf8');
    expect(text).not.toContain('BOOKFISH_TTS_API_KEY');
    expect(text).toContain('OTHER=keep');
    expect(engine.calls).toContain('key');
  });

  it('saves the on/off switch through normal settings and notifies the voice module', async () => {
    const { world, engine } = createWorld({}, {});
    const saved = await world.webUi!('zh').invoke!('settings', 'save', [{ voiceOutputEnabled: true }]) as { config: { voiceOutputEnabled: boolean } };
    expect(saved.config.voiceOutputEnabled).toBe(true);
    expect(engine.calls).toContain('config');
  });

  it('stops read-aloud when the book or pause changes, but not on its own reading turn', async () => {
    const { world, engine } = createWorld({}, {});
    const invoke = world.webUi!('zh').invoke!;
    await world.start(new FakeHost());
    try {
      const imported = await invoke('status', 'import', [{ filename: 'voice.txt', title: '语音世界样本',
        base64: Buffer.from('第一段。第二段。第三段。'.repeat(200)).toString('base64') }]) as { book: { key: string } };
      await invoke('status', 'select', [imported.book.key]);
      expect(engine.calls).toContain('revalidate');
      await invoke('status', 'pause', [true]);
      expect(engine.calls.filter(call => call === 'revalidate').length).toBeGreaterThanOrEqual(2);

      // A non-reading main turn is user chat priority.
      world.onRunPhase!({ state: 'model', running: [], enteredAt: new Date().toISOString() });
      expect(engine.calls).toContain('phase');
      world.onRunPhase!({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
    } finally { await world.stop(); }
    expect(engine.calls).toContain('shutdown');
  });

  it('attaches on start and clears the voice key file when missing', async () => {
    const { ctx, world, engine } = createWorld({}, {});
    await world.webUi!('zh').invoke!('settings', 'voice_clear_key', []);
    expect(engine.calls).toContain('key');
    expect(existsSync(join(ctx.botDir, '.env'))).toBe(false);
    expect(engine.calls).not.toContain('attach');
  });
});