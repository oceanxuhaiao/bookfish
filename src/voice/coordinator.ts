import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_CHUNK_CHARS, splitChunks } from './chunk.ts';
import { VoiceConfigError, VoiceError, safeMessage } from './errors.ts';
import { playWav, sweepTempDir } from './player.ts';
import { synthesize } from './tts.ts';
import type {
  VoiceBookSnapshot, VoiceGate, VoiceLogger, VoicePhase, VoicePlaybackEngine, VoiceReadPort,
  VoiceSegment, VoiceStatus, VoiceStopReason,
} from './types.ts';

export interface VoiceCoordinatorOptions {
  port: VoiceReadPort;
  /** Live user setting; read on every gate/status check. */
  enabled: () => boolean;
  /** Fixed BOOKFISH_TTS_API_KEY reader; never logged or exposed. */
  secret: () => string;
  dataDir: string;
  /** Reuses the World's existing Sources.ensureNext when the voice reaches a cached end. */
  fetchNext?: (signal: AbortSignal) => Promise<void>;
  /** Test seams; production callers omit these. */
  synthesize?: (text: string, signal: AbortSignal) => Promise<Uint8Array>;
  play?: (bytes: Uint8Array, options: { tempDir: string; signal: AbortSignal }) => Promise<unknown>;
  logger?: () => VoiceLogger | undefined;
  pollMs?: number;
  chunkChars?: number;
  /** Safety net for a user event that arrives mid-turn without a new phase callback. */
  shouldInterruptForChat?: () => boolean;
}

/**
 * The FIFO carries both audio chunks and explicit "segment complete" markers.
 * A segment's watermark may only advance when its marker is consumed in order —
 * never when the producer merely discovered or synthesized the text.
 */
interface PreparedAudio {
  kind: 'audio';
  bytes: Uint8Array;
  segmentId: number;
}
interface PreparedSegmentComplete {
  kind: 'segment-complete';
  segmentId: number;
}
type PreparedItem = PreparedAudio | PreparedSegmentComplete;

interface PendingMeta {
  taskId: string;
  bookKey: string;
  segmentId: number;
  generation: number;
  expiresAt: number;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

const PREFETCH = 1;
const MAIN_PHASES = new Set(['delivering', 'model', 'tools']);

function readinessMessage(readiness: string): string {
  if (readiness === 'waiting_content') return '目录已发现新章，正文尚未同步完成，朗读等待中。';
  if (readiness === 'caught_up') return '已读到当前目录末尾，等待更新；这不是全书完读。';
  if (readiness === 'conflict') return '连载目录存在冲突，朗读已停止。';
  return '正文暂未就绪，朗读等待中。';
}

/**
 * Owns one read-aloud session. It only reads cached text through VoiceReadPort,
 * never creates reading tasks and never advances the confirmed frontier.
 */
export class VoiceCoordinator implements VoicePlaybackEngine {
  private readonly tempDir: string;
  private readonly chunkChars: number;
  private readonly pollMs: number;

  private phase: VoicePhase = 'idle';
  private error: string | null = null;
  private detail: string | null = null;
  private bookKey: string | null = null;
  private title: string | null = null;
  private generation: number | null = null;
  private totalSegments: number | null = null;
  private voicedUpTo: number | null = null;
  private playingSegmentId: number | null = null;
  private cursor = 0;

  private sessionId: string | null = null;
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private queue: PreparedItem[] = [];
  /** Next segment id the consumer may mark fully voiced in this session, in order. */
  private nextExpectedVoicedSegmentId: number | null = null;
  private producerDone = false;
  private producerWake?: () => void;
  private consumerWake?: () => void;

  private stopReason: VoiceStopReason | undefined;
  private stopInProgress = false;
  private fetchAttemptAt = 0;
  private fetchFailures = 0;
  /** Detail to publish after the prepared/playing queue has fully drained. */
  private waitDetail: string | null = null;
  /** A verified KEY stop that may resume over exactly one authorized segment. */
  private keyRecovery?: { bookKey: string; generation: number; watermark: number; authorizedSegmentId: number };

  private lifecycle: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private attached = false;
  private disposed = false;
  private logger: VoiceLogger | undefined;

  constructor(private readonly opts: VoiceCoordinatorOptions) {
    this.tempDir = join(opts.dataDir, 'bookfish', 'voice-tmp');
    this.chunkChars = opts.chunkChars ?? DEFAULT_CHUNK_CHARS;
    this.pollMs = opts.pollMs ?? 1000;
  }

  attach(log?: VoiceLogger): void {
    this.attached = true;
    this.logger = log;
  }

  status(): VoiceStatus {
    const enabled = this.opts.enabled();
    const next = this.voicedUpTo !== null ? this.voicedUpTo + 1 : this.cursor;
    const total = this.totalSegments;
    const segmentId = this.playingSegmentId
      ?? (total !== null && total > 0 ? Math.min(next, total - 1) : (this.phase === 'idle' && !this.bookKey ? null : this.cursor));
    return {
      enabled,
      phase: enabled ? this.phase : 'disabled',
      bookKey: this.bookKey,
      title: this.title,
      segmentId,
      voicedUpTo: this.voicedUpTo,
      totalSegments: this.totalSegments,
      keyConfigured: this.hasKey(),
      error: this.error,
      detail: this.detail,
    };
  }

  gate(): VoiceGate {
    const enabled = this.opts.enabled();
    if (!enabled) return { enabled: false, upper: null, bookKey: null, generation: null };
    const snap = this.safeSnapshot();
    const valid = !!snap && !!this.bookKey && snap.bookKey === this.bookKey
      && snap.generation === this.generation && !snap.paused;
    return { enabled: true, upper: valid ? this.voicedUpTo : null, bookKey: this.bookKey, generation: this.generation };
  }

  onRunPhase(phase: { state: string }): void {
    if (this.phase !== 'playing' && this.phase !== 'waiting_content') return;
    if (MAIN_PHASES.has(phase.state)) void this.stop('chat').catch(() => {});
  }

  start(): Promise<VoiceStatus> {
    return this.enqueue(async () => {
      if (this.disposed) throw new VoiceError('state', '语音模块已关闭');
      if (!this.opts.enabled()) throw new VoiceConfigError('请先在配置页开启语音朗读。');
      if (!this.attached) throw new VoiceError('state', 'Bookfish 尚未启动，暂时无法朗读。');
      if (this.opts.shouldInterruptForChat?.()) {
        throw new VoiceConfigError('大肥鱼正在优先处理当前对话，请在聊天结束后再开始朗读。');
      }
      if (!this.hasKey()) throw new VoiceConfigError('尚未保存 MiMo 语音 KEY：请到配置页的语音设置中保存。');
      if (this.phase === 'playing') return this.status();

      let snap = this.readSnapshot();
      if (!snap) throw new VoiceConfigError('书架为空，没有正在读的书。');
      if (snap.paused) throw new VoiceConfigError('阅读已暂停，请先继续阅读再开始朗读。');
      if (snap.complete) throw new VoiceConfigError('这本书已经读完了。');
      if (snap.readiness === 'conflict') throw new VoiceConfigError(readinessMessage(snap.readiness));
      this.assertPendingTasksAllowStart(snap);

      await this.awaitLoop();

      const fresh = this.readSnapshot();
      if (!fresh) throw new VoiceConfigError('书架为空，没有正在读的书。');
      if (fresh.bookKey !== snap.bookKey || fresh.generation !== snap.generation) {
        this.keyRecovery = undefined;
        throw new VoiceConfigError('阅读书籍或正文版本已改变，请刷新后再开始朗读。');
      }
      if (this.opts.shouldInterruptForChat?.()) {
        throw new VoiceConfigError('大肥鱼正在优先处理当前对话，请在聊天结束后再开始朗读。');
      }
      this.assertPendingTasksAllowStart(fresh);
      snap = fresh;

      const watermark = this.voicedUpTo;
      const resumable = this.bookKey === snap.bookKey
        && this.generation === snap.generation
        && watermark !== null && watermark >= 0 && watermark < snap.totalSegments;
      const from = resumable ? Math.max(snap.frontier, watermark + 1) : snap.frontier;
      if (!resumable) { this.voicedUpTo = null; this.keyRecovery = undefined; }
      this.bookKey = snap.bookKey;
      this.title = snap.title;
      this.generation = snap.generation;
      this.totalSegments = snap.totalSegments;
      this.cursor = Math.min(from, snap.totalSegments);
      this.playingSegmentId = null;
      this.error = null;
      this.detail = null;
      this.waitDetail = null;
      this.fetchAttemptAt = 0;
      this.fetchFailures = 0;
      this.sweep();
      this.startTimer();
      this.startLoop();
      // Do NOT consume the recovery authorization here. Starting playback is not
      // the same as completing the authorized segment: a TTS failure, a player
      // failure or a chat interruption can still abort before the segment is
      // fully voiced. The authorization is consumed only in markVoiced().
      return this.status();
    });
  }

  /**
   * Starting is conservative. The full pending metadata interface is the only
   * authority for identity. Without it, a start is refused (fail-closed) unless a
   * legacy interface explicitly reports "no pending task". A non-null legacy task
   * can never be trusted because it carries no book/generation, and it never
   * authorizes KEY recovery.
   */
  private assertPendingTasksAllowStart(snap: VoiceBookSnapshot): void {
    const full = this.opts.port.pendingTasks;
    if (typeof full === 'function') {
      let raw: unknown;
      try { raw = full(); } catch { throw new VoiceConfigError('无法读取未完成的阅读任务，不能开始朗读。'); }
      if (!Array.isArray(raw)) throw new VoiceConfigError('未完成的阅读任务数据不可信，不能开始朗读。');
      const now = Date.now();
      const active: PendingMeta[] = [];
      for (const item of raw) {
        const task = this.validatePending(item);
        // Structural validation happens first: invalid metadata must NOT be
        // mistaken for an expired task. Only real, well-formed, unexpired tasks
        // take part in the gate. Genuinely expired ones are ignored (V2.1.2).
        if (task.expiresAt > now) active.push(task);
      }
      if (active.length === 0) return;
      const watermark = this.voicedUpTo;
      const sameIdentity = active.every(task => task.bookKey === snap.bookKey && task.generation === snap.generation);
      const beyond = active.filter(task => watermark === null || task.segmentId > watermark);
      const normalSafe = sameIdentity && beyond.length === 0;
      const recovery = this.keyRecovery;
      const recoveryValid = !!recovery && !!this.bookKey && this.generation !== null
        && recovery.bookKey === snap.bookKey && recovery.generation === snap.generation
        && this.bookKey === snap.bookKey && this.generation === snap.generation
        && recovery.watermark === watermark;
      // Never silently skip a recovery-authorized segment that Library frontier
      // has already moved past.
      if (recoveryValid && snap.frontier > recovery.authorizedSegmentId) {
        throw new VoiceConfigError('恢复授权段已被阅读进度越过，不能恢复朗读。');
      }
      const keySafe = recoveryValid && sameIdentity && watermark !== null
        && recovery.authorizedSegmentId === watermark + 1
        && beyond.length === 1 && beyond[0]!.segmentId === recovery.authorizedSegmentId;
      if (normalSafe || keySafe) return;
      if (!sameIdentity) throw new VoiceConfigError('未完成的阅读任务属于其他书籍或正文版本，不能恢复朗读。');
      if (recoveryValid && beyond.length === 1) {
        throw new VoiceConfigError('未完成的阅读任务不是已朗读水位之后的下一段，不能恢复朗读。');
      }
      const first = active[0]!;
      throw new VoiceConfigError(`大肥鱼还有未完成的阅读任务（第 ${first.segmentId + 1} 段），请先等待本轮阅读结束或安全取消后再开始朗读。`);
    }

    const legacy = this.opts.port.pendingTask;
    if (typeof legacy !== 'function') {
      // Neither interface exists: we cannot prove there is no pending task.
      throw new VoiceConfigError('无法确认未完成的阅读任务状态，不能开始朗读。');
    }
    let single: unknown;
    try { single = legacy(); } catch { throw new VoiceConfigError('无法读取未完成的阅读任务，不能开始朗读。'); }
    if (single === null) return;
    throw new VoiceConfigError('未完成的阅读任务身份无法验证，不能开始朗读。');
  }

  /** Reject structurally invalid pending metadata instead of guessing. */
  private validatePending(item: unknown): PendingMeta {
    const t = item as Partial<PendingMeta> | null | undefined;
    if (!t || typeof t !== 'object') throw new VoiceConfigError('未完成的阅读任务数据不可信，不能开始朗读。');
    const ok = typeof t.taskId === 'string' && t.taskId.length > 0
      && typeof t.bookKey === 'string' && t.bookKey.length > 0
      && Number.isSafeInteger(t.segmentId) && (t.segmentId as number) >= 0
      && Number.isSafeInteger(t.generation) && (t.generation as number) >= 0
      && typeof t.expiresAt === 'number' && Number.isFinite(t.expiresAt);
    if (!ok) throw new VoiceConfigError('未完成的阅读任务数据不可信，不能开始朗读。');
    return { taskId: t.taskId as string, bookKey: t.bookKey as string, segmentId: t.segmentId as number, generation: t.generation as number, expiresAt: t.expiresAt as number };
  }

  stop(reason: VoiceStopReason = 'user'): Promise<void> {
    return this.enqueue(() => this.stopNow(reason));
  }

  revalidate(): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return;
      if (!this.opts.enabled()) {
        if (this.bookKey !== null || this.voicedUpTo !== null || this.loop) await this.stopNow('config');
        return;
      }
      if ((this.phase === 'playing' || this.phase === 'waiting_content')
        && this.opts.shouldInterruptForChat?.()) {
        await this.stopNow('chat');
        return;
      }
      if (this.bookKey === null) return;
      const snap = this.safeSnapshot();
      if (!snap) { await this.stopNow('book_changed'); return; }
      if (snap.bookKey !== this.bookKey || snap.generation !== this.generation) { await this.stopNow('book_changed'); return; }
      if (snap.paused) { await this.stopNow('pause'); return; }
      if (snap.complete) {
        // Let the producer finish the segment already playing; it will publish
        // idle itself. Only an already-drained loop is stopped here.
        if (this.phase === 'playing') return;
        await this.stopNow('complete'); return;
      }
      this.totalSegments = snap.totalSegments;
      const retryFetch = this.fetchFailures > 0 && this.fetchFailures < 3
        && this.fetchAttemptAt !== 0 && Date.now() - this.fetchAttemptAt >= 30000;
      if (this.phase === 'waiting_content' && snap.readiness !== 'conflict'
        && (this.cursor < snap.totalSegments || retryFetch)) {
        this.startLoop();
        return;
      }
      if (this.phase === 'playing' && !this.loop) this.startLoop();
    });
  }

  onConfigChanged(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.opts.enabled()) await this.stopNow('config');
      else if (this.bookKey === null) { this.phase = 'idle'; this.detail = null; this.error = null; }
    });
  }

  onKeyChanged(): Promise<void> {
    return this.enqueue(() => this.stopNow('key'));
  }

  shutdown(): Promise<void> {
    return this.enqueue(async () => {
      await this.stopNow('shutdown');
      this.stopTimer();
      this.sweep();
      this.attached = false;
      this.logger = undefined;
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.shutdown();
  }

  // --- lifecycle plumbing -------------------------------------------------

  private enqueue<T>(action: () => Promise<T> | T): Promise<T> {
    const next = this.lifecycle.then(action);
    this.lifecycle = next.then(() => {}, () => {});
    return next;
  }

  private async stopNow(reason: VoiceStopReason): Promise<void> {
    const active = this.loop !== undefined || this.controller !== undefined
      || this.phase === 'playing' || this.phase === 'waiting_content' || this.phase === 'paused' || this.phase === 'error';
    if (!active && !['config', 'book_changed', 'pause', 'shutdown', 'key', 'complete'].includes(reason)) return;
    this.stopInProgress = true;
    this.stopReason = reason;
    this.abortLoop();
    await this.awaitLoop();
    this.stopInProgress = false;
    this.stopReason = undefined;
    this.applyStop(reason);
  }

  private startLoop(): void {
    if (this.disposed || !this.attached || !this.opts.enabled() || this.bookKey === null || this.generation === null) return;
    if (this.loop) return;
    const sessionId = randomUUID();
    const controller = new AbortController();
    this.sessionId = sessionId;
    this.controller = controller;
    this.producerDone = false;
    this.queue = [];
    // The consumer may only mark voiced segments in the order this loop produces
    // them, starting at the current cursor (which honours Library frontier).
    this.nextExpectedVoicedSegmentId = this.cursor;
    this.playingSegmentId = null;
    this.error = null;
    this.phase = 'playing';
    this.detail = null;
    this.startTimer();
    const bookKey = this.bookKey;
    const generation = this.generation;
    const loop = this.pipeline(controller.signal, sessionId, bookKey, generation);
    this.loop = loop;
    void loop.then(
      () => { if (this.loop === loop) this.loop = undefined; },
      () => { if (this.loop === loop) this.loop = undefined; },
    );
  }

  private async awaitLoop(): Promise<void> {
    const loop = this.loop;
    if (!loop) return;
    await loop.catch(() => {});
    // The completion handler that clears `loop` is a separate microtask; a
    // stop-then-start in the same turn must not see the settled loop and skip
    // starting a new one.
    if (this.loop === loop) this.loop = undefined;
  }

  private abortLoop(): void {
    try { this.controller?.abort(); } catch { /* already aborted */ }
    this.controller = undefined;
    this.producerDone = true;
    this.producerWake?.();
    this.consumerWake?.();
  }

  private applyStop(reason: VoiceStopReason): void {
    // A chat interruption, a user stop or a TTS/player error must NOT consume a
    // still-unfulfilled recovery authorization: the authorized segment did not
    // finish playing, so the user may resume it. Only a session that loses its
    // identity (config/book_changed/pause/shutdown) or a finished book clears it.
    this.queue = [];
    this.nextExpectedVoicedSegmentId = null;
    this.playingSegmentId = null;
    this.sessionId = null;
    this.controller = undefined;
    this.waitDetail = null;
    this.sweep();

    if (reason === 'complete') {
      this.keyRecovery = undefined;
      this.phase = 'idle';
      this.detail = '本书已读完。';
      this.error = null;
      this.stopTimer();
      return;
    }

    if (reason === 'key') {
      const snap = this.safeSnapshot();
      const keepWatermark = !!snap && this.bookKey !== null && this.generation !== null
        && snap.bookKey === this.bookKey && snap.generation === this.generation && !snap.paused;
      if (keepWatermark) {
        this.phase = 'idle';
        this.detail = '语音 KEY 已更改；已完整播放的连续水位保留，需要时请点击开始朗读。';
        this.error = null;
        this.keyRecovery = this.voicedUpTo !== null && this.bookKey !== null && this.generation !== null
          ? { bookKey: this.bookKey, generation: this.generation, watermark: this.voicedUpTo, authorizedSegmentId: this.voicedUpTo + 1 }
          : undefined;
        this.stopTimer();
        return;
      }
      this.keyRecovery = undefined;
      this.bookKey = null;
      this.title = null;
      this.generation = null;
      this.voicedUpTo = null;
      this.cursor = 0;
      this.totalSegments = null;
      this.phase = 'idle';
      this.error = null;
      this.detail = null;
      this.stopTimer();
      return;
    }

    if (reason === 'user' || reason === 'chat' || reason === 'error') {
      if (this.bookKey !== null && this.voicedUpTo !== null) {
        this.phase = reason === 'error' ? 'error' : 'paused';
        this.detail = reason === 'chat'
          ? '聊天优先，朗读已停止；继续时可能重播尚未确认的段落。'
          : reason === 'user' ? '朗读已停止；继续时可能重播尚未确认的段落。' : this.detail;
      } else {
        this.phase = reason === 'error' ? 'error' : 'idle';
        this.detail = reason === 'chat'
          ? '聊天优先，朗读已停止；继续时可能重播尚未确认的段落。'
          : '朗读已停止；继续时可能重播尚未确认的段落。';
      }
      if (reason !== 'error') this.error = null;
      // A stopped/errored/paused session needs no periodic revalidation; the next
      // start recreates the timer. waiting_content keeps its timer for new text.
      this.stopTimer();
      return;
    }

    this.keyRecovery = undefined;
    this.bookKey = null;
    this.title = null;
    this.generation = null;
    this.voicedUpTo = null;
    this.cursor = 0;
    this.totalSegments = null;
    this.phase = 'idle';
    this.error = null;
    this.detail = reason === 'config' ? '语音朗读已关闭。'
      : reason === 'book_changed' ? '已切换书籍或正文版本，朗读已停止。'
        : reason === 'pause' ? '阅读已暂停，朗读已停止；恢复后会从当前确认位置重新朗读，可能重播未确认段落。'
          : reason === 'shutdown' ? 'Bookfish 已停止，朗读已结束。'
              : '朗读已停止。';
    this.stopTimer();
  }

  private fail(error: unknown): void {
    if (this.sessionId === null && this.phase !== 'playing') return;
    const message = safeMessage(error);
    this.error = message;
    this.phase = 'error';
    this.detail = null;
    this.logger?.warn('Bookfish voice stopped after an error', { error: message });
    this.stopTimer();
    this.abortLoop();
  }

  private requestStop(reason: VoiceStopReason): void {
    if (this.stopReason) return;
    this.stopReason = reason;
    this.abortLoop();
  }

  private async pipeline(signal: AbortSignal, sessionId: string, bookKey: string, generation: number): Promise<void> {
    await Promise.allSettled([
      this.produce(signal, sessionId, bookKey, generation),
      this.consume(signal, sessionId, bookKey, generation),
    ]);
    if (this.sessionId !== sessionId) return;
    const reason = this.stopReason;
    if (reason && !this.stopInProgress) {
      this.stopReason = undefined;
      this.applyStop(reason);
      return;
    }
    this.queue = [];
    this.playingSegmentId = null;
    this.sessionId = null;
    this.controller = undefined;
    this.sweep();
    if (this.phase === 'playing') {
      this.phase = 'waiting_content';
      this.detail = this.waitDetail ?? '朗读循环已结束，等待后续正文。';
      this.waitDetail = null;
    } else if (this.phase !== 'waiting_content' && this.phase !== 'paused') {
      // complete / error / idle need no periodic polling until the next start.
      this.stopTimer();
    }
  }

  // --- producer / consumer ------------------------------------------------

  private async produce(signal: AbortSignal, sessionId: string, bookKey: string, generation: number): Promise<void> {
    try {
      while (!signal.aborted && this.sessionId === sessionId) {
        if (!this.opts.enabled()) { this.requestStop('config'); return; }
        const snap = this.safeSnapshot();
        if (!snap) { this.requestStop('book_changed'); return; }
        if (snap.bookKey !== bookKey || snap.generation !== generation) { this.requestStop('book_changed'); return; }
        if (snap.paused) { this.requestStop('pause'); return; }
        if (snap.complete) { this.phase = 'idle'; this.detail = '本书已读完。'; this.stopTimer(); return; }
        if (snap.readiness === 'conflict') { this.waitForContent(readinessMessage('conflict')); return; }
        this.totalSegments = snap.totalSegments;
        if (this.cursor < snap.frontier) this.cursor = snap.frontier;
        // Cached text may still be read even while the serial source is waiting for
        // new chapters; only a catalog conflict stops the voice outright.
        if (this.cursor >= snap.totalSegments) {
          const moved = await this.ensureContent(signal, sessionId, snap);
          if (moved) continue;
          return;
        }

        const segment = this.opts.port.segments(this.cursor, 1)[0];
        if (!segment || segment.id !== this.cursor) { this.waitForContent('下一段正文尚未缓存。'); return; }
        this.waitDetail = null;
        const chunks = splitChunks(segment.text, this.chunkChars).filter(chunk => chunk.trim().length > 0);

        for (let index = 0; index < chunks.length; index += 1) {
          await this.waitForRoom(signal, sessionId);
          if (signal.aborted || this.sessionId !== sessionId) return;
          const check = this.safeSnapshot();
          if (!this.validFor(check, bookKey, generation)) {
            this.requestStop(check?.paused ? 'pause' : 'book_changed');
            return;
          }
          if (!this.hasKey()) throw new VoiceConfigError('语音 KEY 已删除，朗读停止。');
          const bytes = await this.synthesize(chunks[index]!, signal);
          if (signal.aborted || this.sessionId !== sessionId) return;
          this.queue.push({ kind: 'audio', bytes, segmentId: segment.id });
          this.consumerWake?.();
        }

        // Enqueue the completion marker for both audio and blank segments. It is
        // just another FIFO item, so the consumer can only consume it after every
        // earlier audio chunk has finished playing. Blank segments create no TTS.
        await this.waitForRoom(signal, sessionId);
        if (signal.aborted || this.sessionId !== sessionId) return;
        {
          const check = this.safeSnapshot();
          if (!this.validFor(check, bookKey, generation)) {
            this.requestStop(check?.paused ? 'pause' : 'book_changed');
            return;
          }
        }
        this.queue.push({ kind: 'segment-complete', segmentId: segment.id });
        this.consumerWake?.();
        this.cursor += 1;
      }
    } catch (error) {
      if (signal.aborted || this.sessionId !== sessionId) return;
      if (error instanceof VoiceError && error.code === 'aborted') return;
      this.fail(error);
    } finally {
      this.producerDone = true;
      this.consumerWake?.();
    }
  }

  private async consume(signal: AbortSignal, sessionId: string, bookKey: string, generation: number): Promise<void> {
    try {
      while (!signal.aborted && this.sessionId === sessionId) {
        while (!signal.aborted && this.queue.length === 0) {
          if (this.producerDone) return;
          const wake = this.deferred();
          this.consumerWake = wake.resolve;
          await this.waitSignal(wake.promise, signal);
          this.consumerWake = undefined;
        }
        if (signal.aborted || this.sessionId !== sessionId) return;
        const item = this.queue.shift();
        this.producerWake?.();
        if (!item) continue;

        const check = this.safeSnapshot();
        if (!this.validFor(check, bookKey, generation)) {
          this.requestStop(check?.paused ? 'pause' : 'book_changed');
          return;
        }

        if (item.kind === 'audio') {
          this.playingSegmentId = item.segmentId;
          const result = await this.play(item.bytes, signal);
          if (signal.aborted || this.sessionId !== sessionId) return;
          if (result && typeof result === 'object' && 'aborted' in result && (result as { aborted?: boolean }).aborted) return;
          continue;
        }

        // segment-complete: the only place the watermark may advance.
        this.playingSegmentId = null;
        const outcome = this.completeSegment(item.segmentId, bookKey, generation);
        if (outcome === 'skipped') { this.requestStop('book_changed'); return; }
        if (outcome === 'advanced') this.detail = null;
      }
    } catch (error) {
      if (signal.aborted || this.sessionId !== sessionId) return;
      if (error instanceof VoiceError && error.code === 'aborted') return;
      this.fail(error);
    }
  }

  private async ensureContent(signal: AbortSignal, sessionId: string, snap: VoiceBookSnapshot): Promise<boolean> {
    this.waitForContent(snap.readiness === 'waiting_content' ? readinessMessage('waiting_content')
      : snap.readiness === 'caught_up' ? readinessMessage('caught_up') : '已读到当前缓存末尾，等待后续正文。');
    if (!this.opts.fetchNext) return false;
    const now = Date.now();
    if (this.fetchAttemptAt !== 0 && now - this.fetchAttemptAt < 30000) return false;
    this.fetchAttemptAt = now;
    try {
      await this.opts.fetchNext(signal);
      if (signal.aborted || this.sessionId !== sessionId) return false;
      const after = this.safeSnapshot();
      if (after && after.totalSegments > this.cursor && after.readiness !== 'conflict') {
        this.phase = 'playing';
        this.detail = null;
        this.waitDetail = null;
        this.fetchFailures = 0;
        this.fetchAttemptAt = 0;
        return true;
      }
      this.fetchFailures += 1;
      this.waitForContent(`下一章正文尚未缓存${this.fetchFailures >= 3 ? '（多次获取未成功，可稍后继续）' : ''}。`);
      return false;
    } catch (error) {
      if (signal.aborted) return false;
      this.fetchFailures += 1;
      this.waitForContent(`下一章正文获取失败：${safeMessage(error, 200)}`);
      return false;
    }
  }

  private waitForContent(detail: string): void {
    // Keep `playing` while prepared audio / the current segment still plays;
    // the pipeline publishes `waiting_content` only after the queue drains.
    this.waitDetail = detail;
  }

  /**
   * Advance the watermark for one consumed completion marker. Only a marker that
   * matches this session and the exact next expected segment may advance; stale
   * (duplicate/old-session) markers are ignored and a forward skip is reported so
   * the caller can stop conservatively instead of inventing progress.
   */
  private completeSegment(segmentId: number, bookKey: string, generation: number): 'advanced' | 'stale' | 'skipped' {
    if (this.sessionId === null) return 'stale';
    if (this.bookKey !== bookKey || this.generation !== generation) return 'stale';
    const expected = this.nextExpectedVoicedSegmentId;
    if (expected === null) return 'skipped';
    if (segmentId < expected) return 'stale';
    if (segmentId > expected) return 'skipped';
    const prior = this.voicedUpTo;
    this.voicedUpTo = segmentId;
    this.nextExpectedVoicedSegmentId = segmentId + 1;
    // Fulfillment, not start, ends the KEY recovery authorization, and only the
    // exact authorized segment may consume it. Until then it survives chat/user
    // stops, TTS failures and player failures so the user can resume.
    const grant = this.keyRecovery;
    if (grant && this.bookKey === grant.bookKey && this.generation === grant.generation
      && prior === grant.watermark && segmentId === grant.authorizedSegmentId) {
      this.keyRecovery = undefined;
    }
    return 'advanced';
  }

  private validFor(snap: VoiceBookSnapshot | null, bookKey: string, generation: number): boolean {
    return !!snap && this.opts.enabled() && snap.bookKey === bookKey
      && snap.generation === generation && !snap.paused;
  }

  private async waitForRoom(signal: AbortSignal, sessionId: string): Promise<void> {
    while (!signal.aborted && this.sessionId === sessionId && this.queue.length >= PREFETCH) {
      const wake = this.deferred();
      this.producerWake = wake.resolve;
      await this.waitSignal(wake.promise, signal);
      this.producerWake = undefined;
    }
  }

  private deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }

  private waitSignal(promise: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const onAbort = () => { signal.removeEventListener('abort', onAbort); resolve(); };
      signal.addEventListener('abort', onAbort, { once: true });
      void promise.then(() => { signal.removeEventListener('abort', onAbort); resolve(); });
    });
  }

  private async synthesize(text: string, signal: AbortSignal): Promise<Uint8Array> {
    if (this.opts.synthesize) return this.opts.synthesize(text, signal);
    return synthesize({ apiKey: this.opts.secret().trim() }, text, { signal });
  }

  private async play(bytes: Uint8Array, signal: AbortSignal): Promise<unknown> {
    if (this.opts.play) return this.opts.play(bytes, { tempDir: this.tempDir, signal });
    return playWav(bytes, { tempDir: this.tempDir, signal });
  }

  // --- helpers ------------------------------------------------------------

  private readSnapshot(): VoiceBookSnapshot | null {
    const snap = this.opts.port.snapshot();
    if (!snap) return null;
    return snap;
  }

  private safeSnapshot(): VoiceBookSnapshot | null {
    try { return this.opts.port.snapshot(); } catch { return null; }
  }

  private hasKey(): boolean {
    try { return this.opts.secret().trim().length > 0; } catch { return false; }
  }

  private sweep(): void {
    sweepTempDir(this.tempDir);
  }

  private startTimer(): void {
    if (this.pollMs <= 0 || this.timer) return;
    this.timer = setInterval(() => { void this.revalidate().catch(() => {}); }, this.pollMs);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}