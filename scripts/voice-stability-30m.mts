/**
 * V2.1 30-minute isolated voice stability run.
 * Mock TTS + synthetic WAV; real VoiceCoordinator queue, timers and lifecycle.
 * It never calls a network service or plays real audio.
 */
import { mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VoiceCoordinator } from '../src/voice/coordinator.ts';

const OUT = process.env.VOICE_STRESS_OUT ?? 'voice-stability-30m.json';
const DATA = process.env.VOICE_STRESS_DATA ?? join(process.cwd(), 'tmp', 'voice-stress-data');
const DURATION_MS = Number(process.env.VOICE_STRESS_MS ?? 30 * 60 * 1000);
const SEGMENTS = 4000;
const TEMP = join(DATA, 'bookfish', 'voice-tmp');
mkdirSync(TEMP, { recursive: true });

function wav(): Uint8Array {
  const data = 320; const bytes = Buffer.alloc(44 + data);
  bytes.write('RIFF', 0, 'ascii'); bytes.writeUInt32LE(36 + data, 4); bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii'); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28); bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34);
  bytes.write('data', 36, 'ascii'); bytes.writeUInt32LE(data, 40); bytes.fill(128, 44); return new Uint8Array(bytes);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const state = { bookKey: 'A', title: '稳定性样本A', generation: 1, frontier: 0, totalSegments: SEGMENTS, paused: false, complete: false, readiness: 'backlog' };
const sequences: Record<string, number[]> = { A: [], B: [] };
const synthByBook: Record<string, number[]> = { A: [], B: [] };
let phase = 'playing';
let maxActivePlayers = 0;
let activePlayers = 0;
let maxTempFiles = 0;
let tempSamples = 0;
let errors: string[] = [];
let rapidMaxActive = 0;

const coordinator = new VoiceCoordinator({
  port: {
    snapshot: () => ({ ...state }),
    segments: (from, max) => Array.from({ length: max }, (_, offset) => {
      const id = from + offset;
      return { id, text: `SEG:${state.bookKey}:${id}:` + '海风沿着归途吹过长街。'.repeat(5) };
    }),
    pendingTask: () => null,
  },
  enabled: () => true,
  secret: () => 'stress-test-key',
  dataDir: DATA,
  synthesize: async (text) => {
    const match = /^SEG:([AB]):(\d+):/.exec(text);
    if (!match) throw new Error('unexpected synthesis text');
    synthByBook[match[1]!]!.push(Number(match[2]));
    await sleep(40);
    return wav();
  },
  play: async (bytes, { tempDir, signal }) => {
    activePlayers += 1; maxActivePlayers = Math.max(maxActivePlayers, activePlayers);
    const file = join(tempDir, `stress-${activePlayers}-${Date.now()}.wav`);
    writeFileSync(file, bytes);
    tempSamples += 1;
    maxTempFiles = Math.max(maxTempFiles, readdirSync(tempDir).filter(name => name.endsWith('.wav')).length);
    try { await sleep(900); } finally {
      try { unlinkSync(file); } catch {}
      activePlayers -= 1;
    }
    if (signal.aborted) return { aborted: true };
    return { aborted: false };
  },
  pollMs: 1000,
});
coordinator.attach();

const startedAt = Date.now();
function elapsed() { return Date.now() - startedAt; }
function log(line: string) { console.log(`[${Math.round(elapsed() / 1000)}s] ${line}`); }

await coordinator.start();
const heapSamples: Array<{ at: number; heapMb: number; rssMb: number; voicedUpTo: number | null; phase: string }> = [];
const timers: ReturnType<typeof setInterval>[] = [];
timers.push(setInterval(() => {
  const mem = process.memoryUsage();
  const status = coordinator.status();
  if (status.phase === 'error' && status.error) errors.push(status.error);
  heapSamples.push({ at: elapsed(), heapMb: Math.round(mem.heapUsed / 1048576), rssMb: Math.round(mem.rss / 1048576), voicedUpTo: status.voicedUpTo, phase: status.phase });
  log(`phase=${status.phase} voiced=${status.voicedUpTo} heap=${Math.round(mem.heapUsed / 1048576)}MB rss=${Math.round(mem.rss / 1048576)}MB`);
}, 60_000));

// Scheduled interruptions: stop/resume, switch book, stop/resume.
timers.push(setTimeout(async () => {
  log('user stop #1');
  await coordinator.stop('user');
  await sleep(2000);
  await coordinator.start();
  log('resumed #1');
}, 300_000));
timers.push(setTimeout(async () => {
  log('switch to book B');
  state.bookKey = 'B'; state.title = '稳定性样本B'; state.generation += 1;
  await coordinator.revalidate();
  await coordinator.start();
  log('book B started');
}, 900_000));
timers.push(setTimeout(async () => {
  log('chat stop');
  coordinator.onRunPhase({ state: 'model' });
  await sleep(1500);
  await coordinator.start();
  log('resumed after chat');
}, 1_500_000));
timers.push(setTimeout(async () => {
  log('20 rapid stop/start cycles');
  for (let i = 0; i < 20; i += 1) {
    const s = coordinator.start();
    await coordinator.stop('user');
    await s.catch(() => {});
    await coordinator.start();
  }
  rapidMaxActive = maxActivePlayers;
  log('rapid cycles done');
}, 1_680_000));

await sleep(DURATION_MS);
for (const timer of timers) clearInterval(timer as unknown as ReturnType<typeof setInterval>);
await coordinator.dispose();

function prefixOk(list: number[]): { length: number; duplicates: number; missing: number } {
  let length = 0; let duplicates = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === length) length += 1;
    else if ((list[i] ?? -1) < length) duplicates += 1;
    else break;
  }
  const expected = list.length ? Math.max(...list) + 1 : 0;
  return { length, duplicates, missing: Math.max(0, expected - length - duplicates) };
}
const result = {
  durationSeconds: Math.round(elapsed() / 1000),
  maxActivePlayers,
  rapidMaxActive,
  maxTempFiles,
  leftOverTempWav: readdirSync(TEMP).filter(name => name.endsWith('.wav')).length,
  finalPhase: coordinator.status().phase,
  errors,
  sequences: { A: prefixOk(synthByBook.A), B: prefixOk(synthByBook.B) },
  samples: { synthA: synthByBook.A.length, synthB: synthByBook.B.length, heap: heapSamples },
  pass: maxActivePlayers <= 1 && rapidMaxActive <= 1 && maxTempFiles <= 2 && errors.length === 0,
};
writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log('RESULT', JSON.stringify({ ...result, samples: { ...result.samples, heap: 'see json' } }));
rmSync(DATA, { recursive: true, force: true });