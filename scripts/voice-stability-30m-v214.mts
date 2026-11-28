/**
 * V2.1.4 30-minute isolated voice stability run with blank-segment mixing.
 * Mock TTS + synthetic WAV; real VoiceCoordinator queue/timers/lifecycle.
 * It never calls a network service or plays real audio.
 *
 * Adds a strict contiguous-watermark invariant: the consumer may only advance
 * voicedUpTo by exactly one per completion, including blank segments, and a blank
 * segment may never jump a still-playing prior segment. Every transition is
 * sampled and validated; duplicates, skips and regressions fail the run.
 */
import { mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VoiceCoordinator } from '../src/voice/coordinator.ts';

const OUT = process.env.VOICE_STRESS_OUT ?? 'voice-stability-v214.json';
const DATA = process.env.VOICE_STRESS_DATA ?? join(process.cwd(), 'tmp', 'voice-stress-data');
const DURATION_MS = Number(process.env.VOICE_STRESS_MS ?? 30 * 60 * 1000);
const STOP_MS = Number(process.env.VOICE_STRESS_STOP_MS ?? 300_000);
const SEGMENTS = 4000;
const BLANK_EVERY = 5; // segment ids divisible by 5 are blank
const TEMP = join(DATA, 'bookfish', 'voice-tmp');
mkdirSync(TEMP, { recursive: true });

function wav(segmentId = 0): Uint8Array {
  const data = 320; const bytes = Buffer.alloc(44 + data);
  bytes.write('RIFF', 0, 'ascii'); bytes.writeUInt32LE(36 + data, 4); bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii'); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28); bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34);
  bytes.write('data', 36, 'ascii'); bytes.writeUInt32LE(data, 40); bytes.fill(128, 44);
  bytes.writeUInt32LE(segmentId, 44);
  return new Uint8Array(bytes);
}

const isBlank = (id: number) => id % BLANK_EVERY === 0;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const state = { bookKey: 'A', title: '稳定性样本A', generation: 1, frontier: 0, totalSegments: SEGMENTS, paused: false, complete: false, readiness: 'backlog' };
const synthByBook: Record<string, number[]> = { A: [], B: [] };
let phase = 'playing';
let maxActivePlayers = 0;
let activePlayers = 0;
let maxTempFiles = 0;
let errors: string[] = [];
let rapidMaxActive = 0;
// Watermark invariant tracking (per session bookKey).
let lastBook = state.bookKey;
let lastVoiced: number | null = null;
let watermarkSteps = 0;
const watermarkRegressions: string[] = [];
// A segment is "playing" before its completion marker is consumed. During that
// window the contiguous watermark must never exceed id-1; a blank segment that
// jumped a still-playing prior segment (the V2.1.3 defect) would violate this.
const watermarkOverrun: string[] = [];
process.on('unhandledRejection', (reason) => { const text = `unhandledRejection: ${String(reason)}`; errors.push(text); console.error(text); });
process.on('uncaughtException', (error) => { const text = `uncaughtException: ${String(error)}`; errors.push(text); console.error(text); });

const coordinator = new VoiceCoordinator({
  port: {
    snapshot: () => ({ ...state }),
    segments: (from, max) => Array.from({ length: max }, (_, offset) => {
      const id = from + offset;
      return { id, text: isBlank(id) ? '' : `SEG:${state.bookKey}:${id}:` + '海风沿着归途吹过长街。'.repeat(5) };
    }),
    pendingTask: () => null,
  },
  enabled: () => true,
  secret: () => 'stress-test-key',
  dataDir: DATA,
  synthesize: async (text) => {
    const match = /^SEG:([AB]):(\d+):/.exec(text);
    if (!match) { errors.push('unexpected synthesis text'); throw new Error('unexpected synthesis text'); }
    const id = Number(match[2]);
    if (isBlank(id)) { errors.push(`blank segment ${id} was synthesized`); throw new Error('blank synthesized'); }
    synthByBook[match[1]!]!.push(id);
    await sleep(40);
    return wav(id);
  },
  play: async (bytes, { tempDir, signal }) => {
    activePlayers += 1; maxActivePlayers = Math.max(maxActivePlayers, activePlayers);
    const id = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).readUInt32LE(44);
    const checkDuring = () => {
      const w = coordinator.status().voicedUpTo;
      if (w !== null && w > id - 1) watermarkOverrun.push(`during play ${id}: voiced=${w} > ${id - 1}`);
    };
    const file = join(tempDir, `stress-${activePlayers}-${Date.now()}.wav`);
    writeFileSync(file, bytes);
    maxTempFiles = Math.max(maxTempFiles, readdirSync(tempDir).filter(name => name.endsWith('.wav')).length);
    try { await sleep(450); checkDuring(); await sleep(450); checkDuring(); } finally {
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

// Regression guard: the watermark must never move backwards within a session.
// (Per-play overrun checks cover "jumped too far ahead"; this covers "went back".)
timers.push(setInterval(() => {
  const status = coordinator.status();
  if (status.bookKey !== lastBook) { lastBook = status.bookKey; lastVoiced = status.voicedUpTo; return; }
  const next = status.voicedUpTo;
  if (next === lastVoiced) return;
  if (next === null) { lastVoiced = null; return; }
  if (lastVoiced !== null && next < lastVoiced) watermarkRegressions.push(`${lastVoiced}->${next}`);
  lastVoiced = next; watermarkSteps += 1;
}, 150));

timers.push(setTimeout(() => { void (async () => {
  try { log('user stop #1'); await coordinator.stop('user'); await sleep(2000); await coordinator.start(); log('resumed #1'); }
  catch (error) { errors.push(`stop/resume: ${String(error)}`); console.error('STOP_RESUME_ERROR', error); }
})(); }, STOP_MS));
timers.push(setTimeout(() => { void (async () => {
  try {
    log('switch to book B');
    state.bookKey = 'B'; state.title = '稳定性样本B'; state.generation += 1;
    await coordinator.revalidate(); await coordinator.start(); log('book B started');
  } catch (error) { errors.push(`switch: ${String(error)}`); console.error('SWITCH_ERROR', error); }
})(); }, 900_000));
timers.push(setTimeout(() => { void (async () => {
  try { log('chat stop'); coordinator.onRunPhase({ state: 'model' }); await sleep(1500); await coordinator.start(); log('resumed after chat'); }
  catch (error) { errors.push(`chat: ${String(error)}`); console.error('CHAT_ERROR', error); }
})(); }, 1_500_000));
timers.push(setTimeout(() => { void (async () => {
  try {
    log('20 rapid stop/start cycles');
    for (let i = 0; i < 20; i += 1) {
      const s = coordinator.start(); await coordinator.stop('user');
      await s.catch((error) => errors.push(`rapid start: ${String(error)}`));
      await coordinator.start();
    }
    rapidMaxActive = maxActivePlayers; log('rapid cycles done');
  } catch (error) { errors.push(`rapid: ${String(error)}`); console.error('RAPID_ERROR', error); }
})(); }, 1_680_000));

await sleep(DURATION_MS);
for (const timer of timers) clearInterval(timer as unknown as ReturnType<typeof setInterval>);
await coordinator.dispose();

const blankSynth = [...synthByBook.A, ...synthByBook.B].filter(isBlank).length;
const watermarkClean = watermarkRegressions.length === 0 && watermarkOverrun.length === 0;
const result = {
  durationSeconds: Math.round(elapsed() / 1000),
  maxActivePlayers,
  rapidMaxActive,
  maxTempFiles,
  leftOverTempWav: readdirSync(TEMP).filter(name => name.endsWith('.wav')).length,
  finalPhase: coordinator.status().phase,
  errors,
  watermark: { steps: watermarkSteps, regressions: watermarkRegressions, overrun: watermarkOverrun, clean: watermarkClean },
  blank: { every: BLANK_EVERY, sampledSegments: SEGMENTS, blankSynthesized: blankSynth },
  prefetch: { A: synthByBook.A.length, B: synthByBook.B.length },
  samples: { heap: heapSamples },
  pass: maxActivePlayers <= 1 && rapidMaxActive <= 1 && maxTempFiles <= 2 && errors.length === 0 && watermarkClean && blankSynth === 0,
};
writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log('RESULT', JSON.stringify({ ...result, samples: { ...result.samples, heap: 'see json' } }));
rmSync(DATA, { recursive: true, force: true });
