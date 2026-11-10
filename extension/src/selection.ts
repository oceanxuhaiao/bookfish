import { randomUUID } from 'node:crypto';
import { statfsSync } from 'node:fs';
import type { RunPhase, WorldHost } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { BookfishConfigSection } from './config.ts';
import type { Library } from './library.ts';
import type { ReadingScheduler } from './scheduler.ts';
import type { NovelFetches, NovelSearchJobView, NovelTaskView } from './novel-fetch.ts';
import { normalizeIdentity, type NovelSearchCandidate } from './novel-match.ts';
import {
  workKey, type FailedWork, type ReadingQueueItem, type SelectionCandidate,
  type SelectionFailure, type SelectionIntent, type SelectionRound, type SelectionState,
} from './selection-types.ts';

const OPPORTUNITY_INTERVAL_MS = 30_000;
const CANDIDATE_TTL_MS = 30 * 60_000;
const ROUND_COOLDOWN_MS = 6 * 60 * 60_000;
const MAX_ROUND_ATTEMPTS = 3;

export interface SelectionGate { allowed: boolean; code: string; message: string }
export interface SelectionViewIntent {
  id: string; title: string; author: string; reason: string; status: string; createdAt: number; updatedAt: number;
  source?: string; candidateCount: number; bookKey?: string; failure?: SelectionFailure;
  candidates?: Array<{ candidateId: string; title: string; author: string; source: string; available: boolean; expiresAt: number }>;
  task?: { id: string; state: string; stage: string; percent: number; downloaded: number; total: number; error?: string; warningCount: number };
}
export interface SelectionView {
  enabled: boolean; mode: 'notify' | 'auto'; gate: SelectionGate;
  intents: SelectionViewIntent[];
  queue: Array<ReadingQueueItem & { bookExists: boolean; bookComplete: boolean; sourceTitle?: string }>;
  commitment: null | { intentId: string; bookKey: string; title: string; readiness: string | null; complete: boolean };
  round: null | { day: string; attempts: number; status: string; cooldownUntil: number | null; workTitles: string[] };
  cooldownUntil: number | null;
  lastOpportunityDay: string | null;
  notice: string | null;
}

export interface SelectionSummary {
  enabled: boolean; mode: 'notify' | 'auto'; gate: SelectionGate;
  intent: SelectionViewIntent | null;
  queue: Array<{ intentId: string; title: string; bookKey: string; status: string; notBefore: number | null }>;
  commitment: SelectionView['commitment'];
  round: SelectionView['round'];
}

interface SelectionOptions {
  library: Library;
  novelFetches: NovelFetches;
  scheduler: ReadingScheduler;
  cfg: () => BookfishConfigSection;
  timezone: string;
  now?: () => number;
}

function clampText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value.trim();
}

function dayOf(now: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Mechanical coordinator for autonomous book selection. It never reports reading progress. */
export class SelectionCoordinator {
  private host?: WorldHost;
  private timer?: ReturnType<typeof setInterval>;
  private phase: RunPhase['state'] | 'unknown' = 'unknown';
  private idleSince = 0;
  private stopped = true;
  private suppressingEvents = false;
  private readonly now: () => number;

  constructor(private readonly options: SelectionOptions) {
    this.now = options.now ?? Date.now;
  }

  private get cfg(): BookfishConfigSection { return this.options.cfg(); }
  private day(): string { return dayOf(this.now(), this.options.timezone); }
  private at(): string { return new Date(this.now()).toISOString(); }
  private state(): SelectionState { return this.options.library.selection(); }
  private update<T>(action: (state: SelectionState) => T): T { return this.options.library.updateSelection(action); }

  start(host: WorldHost): void {
    if (this.host) return;
    this.host = host;
    this.stopped = false;
    this.recover();
    this.timer = setInterval(() => { void this.tick(); }, OPPORTUNITY_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.host = undefined;
    this.phase = 'unknown';
  }

  onRunPhase(phase: RunPhase): void {
    if (phase.state === 'idle' && this.phase !== 'idle') this.idleSince = this.now();
    this.phase = phase.state;
  }

  /** Restart reconciliation: never re-download, re-import or re-queue an already terminal fact. */
  private recover(): void {
    this.suppressingEvents = true;
    try {
      const state = this.state();
      for (const intent of state.intents) {
        if (intent.status === 'searching') {
          this.deferIntent(intent.id, 'searching', '扩展重启中断了搜索，未自动重试。');
          continue;
        }
        if (intent.status === 'acquiring' && intent.acquisitionTaskId) {
          // The importer may have committed the book just before the process died,
          // before the task record or intent receipt was written. Match the exact
          // normalized work and queue that existing book instead of downloading it again.
          const recovered = this.existingWork(intent);
          const persisted = this.options.novelFetches.persisted(intent.acquisitionTaskId);
          if (recovered) {
            this.fulfill(intent.id, recovered.key);
          } else if (persisted?.state === 'complete' && persisted.bookKey && this.bookExists(persisted.bookKey)) {
            this.fulfill(intent.id, persisted.bookKey);
          } else if (persisted?.state === 'failed') {
            this.recordFailure(intent.id, this.classifyFailure(persisted.error ?? '获取失败'), 'persisted');
          } else if (persisted?.state === 'cancelled') {
            this.deferIntent(intent.id, 'cancelled', '获取任务在重启前已被取消。');
          } else {
            this.deferIntent(intent.id, 'restart_interrupted', '扩展重启中断了获取，未自动续传；之后需重新自主搜索或由用户手动继续。');
          }
        }
      }
      this.reconcileQueue();
      this.refresh();
    } finally { this.suppressingEvents = false; }
  }

  private bookExists(bookKey: string): boolean {
    return this.options.library.list().some((book) => book.key === bookKey);
  }

  private bookView(bookKey: string) {
    return this.options.library.list().find((book) => book.key === bookKey);
  }

  private existingWork(intent: SelectionIntent) {
    const title = normalizeIdentity(intent.title), author = normalizeIdentity(intent.author);
    return this.options.library.list().find((book) => normalizeIdentity(book.title) === title && normalizeIdentity(book.author) === author);
  }

  /** Refresh derived commitment/queue facts. Writes only when a meaning changed. */
  refresh(): SelectionState {
    const before = this.state();
    let changed = false;
    const next = structuredClone(before);
    for (const intent of next.intents) {
      if (!intent.bookKey) continue;
      const book = this.bookView(intent.bookKey);
      if (!book) {
        if (!['completed', 'abandoned'].includes(intent.status)) {
          intent.status = 'abandoned'; changed = true;
          intent.failure = { code: 'book_not_found', message: '这本书已不在书架，自选书承诺结束。', at: this.now() };
          intent.updatedAt = this.now();
        }
        continue;
      }
      if (intent.status === 'fulfilled' || intent.status === 'reading') {
        if (book.complete) {
          intent.status = 'completed'; intent.updatedAt = this.now(); changed = true;
        } else if (intent.status === 'fulfilled') {
          intent.status = 'reading'; intent.updatedAt = this.now(); changed = true;
        }
      }
    }
    for (const item of next.queue) {
      const book = this.bookView(item.bookKey);
      if (!book) {
        if (item.status !== 'cancelled') { item.status = 'cancelled'; item.updatedAt = this.now(); changed = true; }
        continue;
      }
      const intent = next.intents.find((entry) => entry.id === item.intentId);
      if (intent?.status === 'completed' || book.complete) {
        if (item.status !== 'done') { item.status = 'done'; item.updatedAt = this.now(); changed = true; }
      } else if (item.status === 'active' && this.options.library.status().current?.key !== item.bookKey) {
        item.status = 'queued'; item.updatedAt = this.now(); changed = true;
      }
    }
    if (!changed) return before;
    return this.update((draft) => { Object.assign(draft, next); return structuredClone(draft); });
  }

  private commitment(state: SelectionState): SelectionState['intents'][number] | undefined {
    return state.intents.find((intent) =>
      !!intent.bookKey && ['fulfilled', 'reading'].includes(intent.status) && !this.bookView(intent.bookKey)?.complete);
  }

  private baseGate(): SelectionGate {
    if (!this.cfg.autonomousAcquisition) return { allowed: false, code: 'autonomous_disabled', message: '自主找书开关未开启。' };
    if (!this.cfg.allowNetwork) return { allowed: false, code: 'network_disabled', message: '小说书源网络访问已关闭，自主找书暂停。' };
    if (this.options.library.status().paused) return { allowed: false, code: 'reading_paused', message: '阅读已暂停；自主找书也会暂停，不会用获取成功解除暂停。' };
    const state = this.refresh();
    const commitment = this.commitment(state);
    if (commitment) return { allowed: false, code: 'self_selected_unfinished', message: `自选书《${commitment.title}》还没读完，暂不找下一本；排队、暂停、临时切书和连载追平都不解除。` };
    const round = state.round;
    const today = round?.day === this.day();
    if (round?.status === 'paused' && today) return { allowed: false, code: 'round_paused', message: '上一轮因全局原因暂停，未自动换书；请稍后重新开始。' };
    if (round?.status === 'succeeded' && today) return { allowed: false, code: 'round_exhausted', message: '今天已经成功找到一本自选书；先读完它，或明天再找。' };
    if ((round?.cooldownUntil ?? 0) > this.now()) {
      const until = new Date(round!.cooldownUntil!).toISOString();
      return { allowed: false, code: 'cooldown', message: `本轮三本都没成功，进入冷却（至 ${until}），不会连续换书。` };
    }
    if (round?.status === 'exhausted' && today && !round.cooldownUntil) {
      return { allowed: false, code: 'cooldown', message: '本轮三本都没成功，先停下冷却。' };
    }
    return { allowed: true, code: 'allowed', message: '' };
  }

  gate(): SelectionGate {
    return this.baseGate();
  }

  /** Start a search for one concrete work. Requires both title and author. */
  startSearch(input: { title?: unknown; author?: unknown; reason?: unknown }): Record<string, unknown> {
    const title = clampText(input.title, 'title', 200);
    const author = clampText(input.author, 'author', 100);
    const reason = clampText(input.reason, 'reason', 1000);
    const gate = this.gate();
    if (!gate.allowed) return { allowed: false, gate, nextAction: 'stop' };
    const key = workKey(title, author);
    const existing = this.options.library.list().find((book) => normalizeIdentity(book.title) === normalizeIdentity(title) && normalizeIdentity(book.author) === normalizeIdentity(author));
    if (existing) {
      return { allowed: false, gate: { allowed: false, code: 'already_in_library', message: `《${existing.title}》已经在书架，不再重复获取。` }, bookKey: existing.key, nextAction: 'stop' };
    }
    const state = this.state();
    if (state.intents.some((intent) => intent.status === 'searching' || intent.status === 'acquiring')) {
      return { allowed: false, gate: { allowed: false, code: 'acquisition_in_progress', message: '已有一条自选书获取在进行，先等它结束。' }, nextAction: 'stop' };
    }
    if (state.failures.some((failure) => failure.workKey === key && failure.day === this.day())) {
      return { allowed: false, gate: { allowed: false, code: 'duplicate_work', message: '这本作品今天已经失败过，不因换源或换版本再次尝试；请换另一本不同作品。' }, nextAction: 'another_work' };
    }
    if (state.round?.day === this.day() && state.round.workKeys.includes(key)) {
      return { allowed: false, gate: { allowed: false, code: 'duplicate_work', message: '这本作品本轮已经尝试过，不因换源或换版本重复获取；请换另一本不同作品。' }, nextAction: 'another_work' };
    }
    const now = this.now();
    const round: SelectionRound = state.round && state.round.day === this.day() && state.round.status === 'open'
      ? { ...state.round, workKeys: [...state.round.workKeys, key] }
      : { id: randomUUID(), day: this.day(), startedAt: now, workKeys: [key], status: 'open', cooldownUntil: null };
    if (round.workKeys.length > MAX_ROUND_ATTEMPTS) {
      return { allowed: false, gate: { allowed: false, code: 'round_exhausted', message: '这一轮已尝试三本不同作品，先停下冷却。' }, nextAction: 'stop' };
    }
    const intent: SelectionIntent = {
      id: randomUUID(), createdAt: now, updatedAt: now, title, author, reason, status: 'proposed',
      origin: 'autonomous', candidates: [], queueOnImport: true,
    };
    try {
      const job = this.options.novelFetches.startSearch(title, author);
      intent.status = 'searching'; intent.searchJobId = job.id;
      this.update((draft) => {
        draft.intents = [...draft.intents, intent].slice(-50);
        draft.round = round;
        draft.lastOpportunityDay = this.day();
        draft.lastOpportunityAt = now;
      });
      return { allowed: true, intentId: intent.id, searchJobId: job.id, gate: { allowed: true, code: 'searching', message: '正在搜索；完成后会收到一次终态通知，不需要反复轮询。' } };
    } catch (error) {
      const failure = this.classifyFailure((error as Error).message);
      // A failed start is global if the engine is unavailable; no attempt is consumed.
      this.update((draft) => {
        draft.round = { ...(draft.round ?? round), workKeys: draft.round?.workKeys.filter((value) => value !== key) ?? [], status: failure.global ? 'paused' : draft.round?.status ?? 'open' };
        const deferred: SelectionIntent = { ...intent, status: 'deferred', failure: { code: failure.code, message: (error as Error).message.slice(0, 1000), at: now } };
        draft.intents = [...draft.intents, deferred].slice(-50);
      });
      return { allowed: false, intentId: intent.id, gate: { allowed: false, code: failure.code, message: failure.message }, nextAction: failure.global ? 'wait' : 'another_work' };
    }
  }

  private classifyFailure(message: string): { code: string; global: boolean; message: string } {
    const text = message.slice(0, 1000);
    if (/ENOSPC|no space|disk full|磁盘|空间不足/iu.test(text)) return { code: 'disk_full', global: true, message: '磁盘空间不足，自动获取已暂停。' };
    if (/engine unavailable|runtime|java|spawn|引擎|Too many novel fetch tasks/iu.test(text)) return { code: 'engine_unavailable', global: true, message: '小说引擎或获取队列不可用，自动获取已暂停。' };
    if (/Bookfish is stopping/iu.test(text)) return { code: 'cancelled', global: true, message: '扩展正在停止，自动获取已暂停。' };
    if (/network|offline|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|fetch failed|网络/iu.test(text)) return { code: 'network_disabled', global: true, message: '网络请求失败，自动获取已暂停，不连续换书。' };
    if (/cancel|取消/iu.test(text)) return { code: 'cancelled', global: true, message: '任务被取消，自动获取已暂停。' };
    if (/Catalog gate|catalog.*reject|目录/iu.test(text)) return { code: 'catalog_rejected', global: false, message: '书源目录未通过校验。' };
    if (/Integrity gate|完整性|校验/iu.test(text)) return { code: 'integrity_failed', global: false, message: '正文未通过完整性校验。' };
    return { code: 'fetch_failed', global: false, message: text || '获取失败。' };
  }

  onSearchDone(job: NovelSearchJobView): void {
    if (this.stopped) return;
    const state = this.state();
    const intent = state.intents.find((entry) => entry.searchJobId === job.id);
    if (!intent || intent.status !== 'searching') return;
    if (job.state === 'failed') {
      this.recordFailure(intent.id, this.classifyFailure(job.error ?? '搜索失败'), 'search');
      return;
    }
    const candidates = (job.candidates ?? []).filter((candidate) => candidate.match === 'exact' && this.sourceAllowed(candidate.source.id));
    if (!candidates.length) {
      this.recordFailure(intent.id, { code: 'no_result', global: false, message: '没有找到书名、作者和允许书源都精确匹配的版本。' }, 'search');
      return;
    }
    const expiresAt = this.now() + CANDIDATE_TTL_MS;
    const stored: SelectionCandidate[] = candidates.slice(0, 12).map((candidate) => ({
      id: randomUUID(), title: candidate.title, author: candidate.author, url: candidate.url,
      revision: candidate.revision, latestChapter: candidate.latestChapter ?? '',
      source: { ...candidate.source }, match: 'exact', expiresAt,
    }));
    this.update((draft) => {
      const target = draft.intents.find((entry) => entry.id === intent.id);
      if (!target || target.status !== 'searching') return;
      target.candidates = stored; target.status = 'awaiting_choice'; target.updatedAt = this.now();
    });
    const updated = this.state().intents.find((entry) => entry.id === intent.id);
    if (!updated || updated.status !== 'awaiting_choice') return;
    if (this.cfg.autonomousAcquisitionMode === 'auto') {
      void this.autoAcquire(intent.id, stored);
    } else {
      this.announce(updated, 'awaiting_choice', 'search');
    }
  }

  private sourceAllowed(sourceId: number): boolean {
    const allowed = this.cfg.autonomousSourceIds;
    if (!allowed) return true;
    return allowed.split(',').map((value) => Number(value.trim())).filter((value) => Number.isSafeInteger(value)).includes(sourceId);
  }

  acquireCandidate(candidateId: unknown, automatic = false): Record<string, unknown> {
    const key = clampText(candidateId, 'candidateId', 80);
    const intent = this.state().intents.find((entry) => entry.candidates.some((candidate) => candidate.id === key));
    if (!intent) throw new Error('Unknown server candidate id; search again');
    return this.acquire(intent.id, key, automatic);
  }

  private candidatePayload(candidate: SelectionCandidate): NovelSearchCandidate {
    return { title: candidate.title, author: candidate.author, url: candidate.url, revision: candidate.revision,
      source: { ...candidate.source }, latestChapter: candidate.latestChapter, lastUpdateTime: '' };
  }

  /**
   * In auto mode, probe exact candidates before starting any download. A
   * candidate whose catalog already fails the same gate is skipped in favor
   * of another exact source; after all fail, the work is failed once, not
   * retried by changing source later.
   */
  private async autoAcquire(intentId: string, candidates: SelectionCandidate[]): Promise<void> {
    const failures: string[] = [];
    for (const candidate of candidates.slice(0, 6)) {
      const current = this.state().intents.find((entry) => entry.id === intentId);
      if (!current || current.status !== 'awaiting_choice') return;
      try {
        const check = await this.options.novelFetches.checkCandidate(this.candidatePayload(candidate));
        if (check.ok) {
          this.acquire(intentId, candidate.id, true);
          return;
        }
        failures.push(`${candidate.source.name}: ${check.reason ?? 'catalog rejected'}`);
        const classified = this.classifyFailure(check.reason ?? '');
        if (classified.global) {
          this.deferIntent(intentId, classified.code, `${classified.message}（候选目录预检失败）`);
          return;
        }
      } catch (error) {
        const message = (error as Error).message || 'candidate preflight failed';
        failures.push(`${candidate.source.name}: ${message}`);
        const classified = this.classifyFailure(message);
        if (classified.global) {
          this.deferIntent(intentId, classified.code, classified.message);
          return;
        }
      }
    }
    const current = this.state().intents.find((entry) => entry.id === intentId);
    if (!current || current.status !== 'awaiting_choice') return;
    this.recordFailure(intentId, { code: 'catalog_rejected', global: false,
      message: `所有精确候选的目录预检都未通过：${failures.slice(0, 4).join('；')}` }, 'preflight');
  }

  acquire(intentId: unknown, candidateId: unknown, automatic = false): Record<string, unknown> {
    const id = clampText(intentId, 'intentId', 80);
    const candidateKey = clampText(candidateId, 'candidateId', 80);
    const state = this.refresh();
    const intent = state.intents.find((entry) => entry.id === id);
    if (!intent) throw new Error('Selection intent not found');
    if (intent.status === 'acquiring' && intent.acquisitionTaskId) {
      return { allowed: true, duplicate: true, taskId: intent.acquisitionTaskId, intent: this.summary(id) };
    }
    if (intent.status !== 'awaiting_choice') throw new Error('This intent is not waiting for a candidate choice');
    const gate = this.gate();
    if (!gate.allowed) return { allowed: false, gate, nextAction: 'stop' };
    const candidate = intent.candidates.find((entry) => entry.id === candidateKey);
    if (!candidate) throw new Error('Candidate does not belong to this intent');
    if (candidate.expiresAt <= this.now()) throw new Error('Candidate has expired; search again');
    if (candidate.match !== 'exact' || !this.sourceAllowed(candidate.source.id)) throw new Error('Candidate is not an exact allowed edition');
    if (this.options.library.list().some((book) => normalizeIdentity(book.title) === normalizeIdentity(candidate.title) && normalizeIdentity(book.author) === normalizeIdentity(candidate.author))) {
      throw new Error('This work is already in the library');
    }
    const budget = Number.isSafeInteger(this.cfg.autonomousDiskBudgetMb) ? this.cfg.autonomousDiskBudgetMb! : 1024;
    try {
      const stats = statfsSync(this.options.library.dir);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      if (freeBytes < budget * 1024 * 1024) {
        const failure = { code: 'disk_full', global: true, message: `可用磁盘低于自主下载安全线 ${budget} MiB，获取已暂停。` };
        this.recordFailure(intent.id, failure, 'disk');
        return { allowed: false, gate: { allowed: false, code: failure.code, message: failure.message }, nextAction: 'wait' };
      }
    } catch { /* statfs is unavailable on some platforms; the engine still fails closed on disk errors */ }
    const payload = this.candidatePayload(candidate);
    let task: NovelTaskView;
    try {
      task = this.options.novelFetches.start(payload, 'autonomous');
    } catch (error) {
      const failure = this.classifyFailure((error as Error).message);
      this.recordFailure(intent.id, failure, 'acquire');
      return { allowed: false, gate: { allowed: false, code: failure.code, message: failure.message }, nextAction: failure.global ? 'wait' : 'another_work' };
    }
    this.update((draft) => {
      const target = draft.intents.find((entry) => entry.id === intent.id);
      if (!target) return;
      target.status = 'acquiring'; target.selectedCandidateId = candidate.id;
      target.acquisitionTaskId = task.id; target.updatedAt = this.now();
    });
    return { allowed: true, duplicate: false, taskId: task.id, state: task.state, intent: this.summary(intent.id), automatic };
  }

  onTaskTerminal(task: NovelTaskView): void {
    if (this.stopped) return;
    const state = this.refresh();
    const intent = state.intents.find((entry) => entry.acquisitionTaskId === task.id);
    if (!intent) return;
    if (task.state === 'complete') {
      if (!task.bookKey || !this.bookExists(task.bookKey)) {
        this.recordFailure(intent.id, { code: 'import_failed', global: false, message: '下载完成但未找到持久化书籍，未安排阅读。' }, 'import');
        return;
      }
      if (intent.status === 'cancelled') {
        // The user cancelled while import was already committing. Nothing can undo
        // the committed book; report the partial receipt and do not queue it.
        let announced: SelectionIntent | undefined;
        this.update((draft) => {
          const target = draft.intents.find((entry) => entry.id === intent.id);
          if (!target) return;
          target.bookKey = task.bookKey!; target.updatedAt = this.now();
          target.failure = { code: 'cancelled', message: '已入架，已取消后续排队；无法撤销已完成的导入。', at: this.now() };
          announced = structuredClone(target);
        });
        if (announced) this.announce(announced, 'cancelled_after_import', 'import');
        return;
      }
      this.fulfill(intent.id, task.bookKey);
      return;
    }
    if (task.state === 'failed') {
      this.recordFailure(intent.id, this.classifyFailure(task.error ?? '获取失败'), 'terminal');
      return;
    }
    if (task.state === 'cancelled') {
      this.deferIntent(intent.id, 'cancelled', '获取被取消；不会自动换书或续传。');
    }
  }

  private recordFailure(intentId: string, failure: { code: string; global: boolean; message: string }, stage: string): void {
    const state = this.refresh();
    const intent = state.intents.find((entry) => entry.id === intentId);
    if (!intent) return;
    const now = this.now();
    const key = workKey(intent.title, intent.author);
    let announced: SelectionIntent | undefined;
    this.update((draft) => {
      const target = draft.intents.find((entry) => entry.id === intentId);
      if (!target || ['completed', 'abandoned', 'cancelled'].includes(target.status)) return;
      target.updatedAt = now;
      target.failure = { code: failure.code, message: failure.message || stage, at: now };
      if (failure.global) {
        target.status = 'deferred';
        if (draft.round?.day === this.day()) {
          draft.round.status = 'paused';
          draft.round.workKeys = draft.round.workKeys.filter((value) => value !== key);
        }
      } else {
        target.status = 'failed';
        const failed: FailedWork = { workKey: key, day: this.day(), intentId, message: (failure.message || stage).slice(0, 500), at: now };
        draft.failures = [...draft.failures.filter((entry) => !(entry.workKey === key && entry.day === failed.day)), failed].slice(-200);
        if (draft.round?.day === this.day()) {
          if (draft.round.workKeys.length >= MAX_ROUND_ATTEMPTS) {
            draft.round.status = 'exhausted'; draft.round.cooldownUntil = now + ROUND_COOLDOWN_MS;
          } else draft.round.status = 'open';
        }
      }
      announced = structuredClone(target);
    });
    if (announced) this.announce(announced, stage, stage);
  }

  private deferIntent(intentId: string, code: string, message: string): void {
    const now = this.now();
    let announced: SelectionIntent | undefined;
    this.update((draft) => {
      const target = draft.intents.find((entry) => entry.id === intentId);
      if (!target || ['completed', 'abandoned', 'cancelled'].includes(target.status)) return;
      target.status = 'deferred'; target.updatedAt = now;
      target.failure = { code, message, at: now };
      if (draft.round?.day === this.day()) draft.round.status = 'paused';
      announced = structuredClone(target);
    });
    if (announced) this.announce(announced, 'deferred', code);
  }

  private fulfill(intentId: string, bookKey: string): void {
    const now = this.now();
    const book = this.bookView(bookKey);
    let announced: SelectionIntent | undefined;
    this.update((draft) => {
      const target = draft.intents.find((entry) => entry.id === intentId);
      if (!target) return;
      target.bookKey = bookKey; target.updatedAt = now;
      target.status = book?.complete ? 'completed' : 'reading';
      if (target.queueOnImport && book) {
        const existing = draft.queue.find((item) => item.intentId === target.id);
        if (!existing) {
          const item: ReadingQueueItem = {
            id: randomUUID(), intentId: target.id, bookKey, title: target.title, source: 'pet',
            status: book.complete ? 'done' : 'queued', addedAt: now, updatedAt: now,
          };
          draft.queue = [...draft.queue, item].slice(-50);
        } else if (existing.bookKey !== bookKey) {
          existing.bookKey = bookKey; existing.updatedAt = now;
        }
      }
      if (draft.round?.day === this.day()) draft.round.status = 'succeeded';
      announced = structuredClone(target);
    });
    if (announced) this.announce(announced, 'book_added', 'import');
  }

  private announce(intent: SelectionIntent, status: string, stage: string): void {
    if (this.suppressingEvents || !this.host) return;
    const notified = `${status}:${intent.acquisitionTaskId ?? intent.searchJobId ?? ''}:${intent.bookKey ?? ''}:${intent.failure?.code ?? ''}`;
    if (intent.notified === notified) return;
    this.update((draft) => {
      const target = draft.intents.find((entry) => entry.id === intent.id);
      if (target) target.notified = notified;
    });
    const text = JSON.stringify({
      intentId: intent.id, title: intent.title, author: intent.author, status, stage,
      ...(intent.bookKey ? { bookKey: intent.bookKey } : {}),
      ...(intent.failure ? { failure: intent.failure } : {}),
      guidance: status === 'book_added'
        ? 'The book is now in the local shelf and queued after the current book. This is not reading progress. Call bookfish_acquire(action="status") to verify the bookKey; optionally call bookfish_acquire(action="plan") to confirm the queue. Do not search for another self-selected book until this one is fully read or the user explicitly abandons it.'
        : status === 'awaiting_choice'
          ? 'Search returned exact candidates. Call bookfish_acquire(action="status") for server candidate ids, then bookfish_acquire(action="start") with one id, or stop if no edition is suitable.'
          : status === 'failed'
            ? 'This work failed terminally. Do not ask the user for permission and do not retry it, change source, change edition or resume it automatically. Immediately propose and search a DIFFERENT work in this round, at most three works.'
            : status === 'cancelled_after_import'
              ? 'The user cancelled during import. The verified book is already in the shelf, so it cannot be undone; it was NOT queued and the self-selected commitment is not active. Do not queue it or start another search on your own; ask the user what to do.'
              : 'Acquisition is paused for a global or user reason. Do not switch to another book automatically; wait for the user or the next opportunity.',
    });
    // A terminal failure or an edition choice needs a new model turn. Piggyback
    // can wait forever when no other event arrives, so wake once with flush.
    const trigger = ['failed', 'awaiting_choice', 'cancelled_after_import'].includes(status) ? 'flush' : 'piggyback';
    this.host.pushEvent({ type: 'bookfish.acquisition_changed', ts: nowIso(this.options.timezone), source: 'bookfish',
      origin: 'internal', senderKey: this.id(), text }, { trigger }).catch(() => undefined);
  }

  private announceOpportunity(): string | null {
    const cfg = this.cfg;
    if (!cfg.autonomousAcquisition || !cfg.allowNetwork) return null;
    const current = this.options.library.status();
    if (current.paused) return null;
    if (current.current && !current.current.complete) return null;
    if (current.current && this.options.library.hasPendingReviewJob(current.current.key)) return null;
    if (current.pending) return null;
    const scheduler = this.options.scheduler.status();
    if (scheduler.routine || scheduler.active || scheduler.manual) return null;
    if (scheduler.restUntil) return null;
    const state = this.refresh();
    if (this.commitment(state)) return null;
    const gate = this.baseGate();
    if (!gate.allowed) return null;
    return '可选的自选书机会：书架目前没有正在读的书，或当前书已确认读完。你可以按自己的兴趣提出一本具体的书名和作者，说明想读的理由，并调用 bookfish_acquire(action="find")（title、author、reason）。优先选公版、独立成书、篇幅较短且书名作者明确的作品；尽量避开合集里的单篇、作者不明、刚发布的网文或版本不清的书，这些在公开书源里更容易没有可用的精确目录。只搜索真实存在的候选，不编造兴趣或版本。也可以不找书，不调用任何工具。若某本作品搜索无结果、获取失败或校验失败，换另一本不同作品；一轮最多三本，成功一本就停。自选书入架后，在确认读完前不再找下一本；暂停、临时切书、重启和连载追平都不解除。';
  }

  private async tick(): Promise<void> {
    if (this.stopped || !this.host) return;
    try {
      this.refresh();
      if (this.cfg.autonomousAcquisitionMode !== 'auto' && this.cfg.autonomousAcquisitionMode !== 'notify') return;
      if (this.phase !== 'idle' || this.now() - this.idleSince < 30_000) return;
      const day = this.day();
      if (this.state().lastOpportunityDay === day) return;
      if (!this.announceOpportunity()) return;
      this.update((draft) => { draft.lastOpportunityDay = day; draft.lastOpportunityAt = this.now(); });
      const host = this.host;
      host.pushDeferred({ type: 'bookfish.selection_opportunity', origin: 'internal', senderKey: 'bookfish',
        render: () => this.stopped ? null : this.announceOpportunity() }, { trigger: 'flush' });
    } catch { /* a scheduler probe must not break the World */ }
  }

  /** Called by the reading scheduler only at a real idle opportunity. */
  autoAdvance(): boolean {
    if (!this.cfg.autonomousAcquisition || !this.cfg.autonomousAcquisitionMode) return false;
    if (!this.host) return false;
    const current = this.options.library.status();
    if (current.paused) return false;
    if (current.current && !current.current.complete) return false;
    if (current.current && this.options.library.hasPendingReviewJob(current.current.key)) return false;
    if (current.pending) return false;
    const scheduler = this.options.scheduler.status();
    if (scheduler.routine) return false;
    if (scheduler.restUntil && scheduler.restUntil > this.now()) return false;
    const state = this.refresh();
    const queue = [...state.queue].filter((item) => item.status === 'queued' && (!item.notBefore || item.notBefore <= this.now())).sort((a, b) => a.addedAt - b.addedAt);
    let selected = false;
    for (const item of queue) {
      const book = this.bookView(item.bookKey);
      if (!book) continue;
      if (book.complete) {
        this.update((draft) => { const target = draft.queue.find((entry) => entry.id === item.id); if (target) { target.status = 'done'; target.updatedAt = this.now(); } });
        continue;
      }
      try {
        this.options.library.select(item.bookKey);
        this.update((draft) => { const target = draft.queue.find((entry) => entry.id === item.id); if (target) { target.status = 'active'; target.updatedAt = this.now(); } });
        selected = true;
      } catch { /* keep the item queued for a later attempt */ }
      break;
    }
    return selected;
  }

  /** Closing the feature or network cancels the still-uncommitted autonomous chain; manual tasks are untouched. */
  onConfigChanged(): void {
    if (this.stopped) return;
    if (this.cfg.autonomousAcquisition && this.cfg.allowNetwork) return;
    const reason = this.cfg.autonomousAcquisition ? '网络访问已关闭' : '自主找书开关已关闭';
    const state = this.state();
    for (const intent of state.intents) {
      if (!['searching', 'awaiting_choice', 'acquiring'].includes(intent.status)) continue;
      if (intent.acquisitionTaskId) {
        try { this.options.novelFetches.cancel(intent.acquisitionTaskId); } catch { /* terminal already */ }
      }
      this.deferIntent(intent.id, 'policy_changed', `${reason}，这次自选书获取已暂停，不自动换书。`);
    }
  }

  onSelectionChanged(bookKey: string): void {
    this.refresh();
    this.update((draft) => {
      for (const item of draft.queue) {
        if (item.bookKey === bookKey && item.status === 'queued') { item.status = 'active'; item.updatedAt = this.now(); }
        else if (item.status === 'active' && item.bookKey !== bookKey) { item.status = 'queued'; item.updatedAt = this.now(); }
      }
    });
  }

  plan(intentId: unknown, action: unknown, notBefore?: unknown): SelectionSummary {
    const id = clampText(intentId, 'intentId', 80);
    if (action !== 'queue' && action !== 'defer') throw new Error('Unsupported reading plan action');
    let when: number | undefined;
    if (notBefore !== undefined) {
      if (typeof notBefore !== 'string' || !notBefore) throw new Error('notBefore must be an ISO date-time');
      when = Date.parse(notBefore);
      if (!Number.isFinite(when) || when < this.now() || when > this.now() + 7 * 24 * 60 * 60_000) throw new Error('notBefore must be within the next seven days');
    }
    const state = this.refresh();
    const intent = state.intents.find((entry) => entry.id === id);
    if (!intent) throw new Error('Selection intent not found');
    if (action === 'defer') {
      const item = state.queue.find((entry) => entry.intentId === id);
      if (!item) throw new Error('No queued reading item exists for this intent');
      this.update((draft) => { const target = draft.queue.find((entry) => entry.id === item.id); if (target) { target.notBefore = when; target.updatedAt = this.now(); } });
      return this.summary(id);
    }
    if (intent.bookKey) {
      const book = this.bookView(intent.bookKey);
      if (!book) throw new Error('Book is no longer in the shelf');
      if (book.complete) throw new Error('Book is already complete');
      this.update((draft) => {
        const target = draft.intents.find((entry) => entry.id === id);
        if (target) target.queueOnImport = true;
        const existing = draft.queue.find((entry) => entry.intentId === id);
        if (existing) {
          if (existing.status === 'cancelled' || existing.status === 'done') { existing.status = 'queued'; existing.updatedAt = this.now(); }
          existing.notBefore = when; existing.updatedAt = this.now();
        } else {
          const item: ReadingQueueItem = { id: randomUUID(), intentId: id, bookKey: book.key, title: intent.title,
            source: 'pet', status: 'queued', addedAt: this.now(), updatedAt: this.now(), ...(when ? { notBefore: when } : {}) };
          draft.queue = [...draft.queue, item].slice(-50);
        }
      });
    } else if (intent.status === 'acquiring' || intent.status === 'awaiting_choice' || intent.status === 'searching') {
      this.update((draft) => {
        const target = draft.intents.find((entry) => entry.id === id);
        if (target) target.queueOnImport = true;
      });
    } else {
      throw new Error('Only an acquiring or fulfilled intent can be queued');
    }
    return this.summary(id);
  }

  abandon(intentId: unknown): SelectionSummary {
    const id = clampText(intentId, 'intentId', 80);
    this.update((draft) => {
      const target = draft.intents.find((entry) => entry.id === id);
      if (!target) throw new Error('Selection intent not found');
      target.status = 'abandoned'; target.updatedAt = this.now();
      target.failure = { code: 'cancelled', message: '用户明确放弃这本自选书，承诺结束。', at: this.now() };
      for (const item of draft.queue) if (item.intentId === id) { item.status = 'cancelled'; item.updatedAt = this.now(); }
      if (draft.round?.day === this.day()) draft.round.status = 'paused';
    });
    return this.summary(id);
  }

  cancel(intentId: unknown): Record<string, unknown> {
    const id = clampText(intentId, 'intentId', 80);
    const state = this.refresh();
    const intent = state.intents.find((entry) => entry.id === id);
    if (!intent) throw new Error('Selection intent not found');
    if (['fulfilled', 'reading'].includes(intent.status)) return { abandoned: true, intent: this.abandon(id) };
    if (intent.acquisitionTaskId) {
      try { this.options.novelFetches.cancel(intent.acquisitionTaskId); } catch { /* terminal already */ }
    }
    this.deferIntent(id, 'cancelled', '用户取消了这次自选书获取。');
    this.update((draft) => {
      const target = draft.intents.find((entry) => entry.id === id);
      if (target) target.status = 'cancelled';
      for (const item of draft.queue) if (item.intentId === id) { item.status = 'cancelled'; item.updatedAt = this.now(); }
    });
    return { cancelled: true, intent: this.summary(id) };
  }

  private reconcileQueue(): void {
    const now = this.now();
    this.update((draft) => {
      for (const intent of draft.intents) {
        if (!intent.bookKey || !intent.queueOnImport || ['abandoned', 'completed', 'cancelled', 'failed', 'deferred'].includes(intent.status)) continue;
        const book = this.bookView(intent.bookKey);
        if (!book || book.complete) continue;
        if (!draft.queue.some((item) => item.intentId === intent.id)) {
          const item: ReadingQueueItem = { id: randomUUID(), intentId: intent.id, bookKey: book.key, title: intent.title,
            source: 'pet', status: 'queued', addedAt: now, updatedAt: now };
          draft.queue = [...draft.queue, item].slice(-50);
        }
      }
      for (const item of draft.queue) {
        const book = this.bookView(item.bookKey);
        const intent = draft.intents.find((entry) => entry.id === item.intentId);
        if (!book || intent?.status === 'abandoned' || intent?.status === 'completed') {
          item.status = !book || intent?.status === 'abandoned' ? 'cancelled' : 'done';
          item.updatedAt = now;
        } else if (item.status === 'active' && this.options.library.status().current?.key !== item.bookKey) {
          item.status = 'queued'; item.updatedAt = now;
        }
      }
    });
  }

  view(): SelectionView {
    const state = this.refresh();
    const commitment = this.commitment(state);
    const gate = this.gate();
    const meaningful = this.cfg.autonomousAcquisition && !gate.allowed &&
      ['self_selected_unfinished', 'cooldown', 'round_paused', 'round_exhausted'].includes(gate.code);
    return {
      enabled: !!this.cfg.autonomousAcquisition, mode: this.cfg.autonomousAcquisitionMode ?? 'auto', gate,
      intents: state.intents.slice(-10).reverse().map((intent) => this.viewIntent(intent)),
      queue: state.queue.map((item) => {
        const book = this.bookView(item.bookKey);
        return { ...item, bookExists: !!book, bookComplete: !!book?.complete, ...(book ? { sourceTitle: book.title } : {}) };
      }),
      commitment: commitment ? { intentId: commitment.id, bookKey: commitment.bookKey!, title: commitment.title,
        readiness: this.bookView(commitment.bookKey!)?.readiness ?? null, complete: !!this.bookView(commitment.bookKey!)?.complete } : null,
      round: state.round ? { day: state.round.day, attempts: state.round.workKeys.length, status: state.round.status,
        cooldownUntil: state.round.cooldownUntil, workTitles: state.intents.filter((intent) => state.round!.workKeys.includes(workKey(intent.title, intent.author))).map((intent) => intent.title) } : null,
      cooldownUntil: state.round?.cooldownUntil ?? null,
      lastOpportunityDay: state.lastOpportunityDay ?? null,
      notice: meaningful ? gate.message : null,
    };
  }

  private viewIntent(intent: SelectionIntent): SelectionViewIntent {
    const candidate = intent.candidates.find((entry) => entry.id === intent.selectedCandidateId) ?? intent.candidates[0];
    let task: SelectionViewIntent['task'];
    if (intent.acquisitionTaskId) {
      try {
        const value = this.options.novelFetches.get(intent.acquisitionTaskId);
        task = { id: value.id, state: value.state, stage: value.stage, percent: value.percent,
          downloaded: value.downloadedChapters, total: value.catalogChapters, ...(value.error ? { error: value.error } : {}), warningCount: value.warningCount };
      } catch {
        const persisted = this.options.novelFetches.persisted(intent.acquisitionTaskId);
        if (persisted) task = { id: persisted.id, state: persisted.state, stage: persisted.stage, percent: persisted.percent,
          downloaded: persisted.downloadedChapters, total: persisted.catalogChapters, ...(persisted.error ? { error: persisted.error } : {}), warningCount: persisted.warningCount };
      }
    }
    return { id: intent.id, title: intent.title, author: intent.author, reason: intent.reason, status: intent.status,
      createdAt: intent.createdAt, updatedAt: intent.updatedAt, candidateCount: intent.candidates.length,
      ...(candidate ? { source: candidate.source.name } : {}), ...(intent.bookKey ? { bookKey: intent.bookKey } : {}),
      ...(intent.candidates.length ? { candidates: intent.candidates.slice(0, 10).map((entry) => ({
        candidateId: entry.id, title: entry.title, author: entry.author, source: entry.source.name,
        available: entry.expiresAt > this.now() && this.sourceAllowed(entry.source.id), expiresAt: entry.expiresAt,
      })) } : {}),
      ...(intent.failure ? { failure: { ...intent.failure } } : {}), ...(task ? { task } : {}) };
  }

  summary(intentId?: unknown): SelectionSummary {
    const state = this.refresh();
    const intent = intentId === undefined ? state.intents.at(-1) : state.intents.find((entry) => entry.id === intentId);
    return {
      enabled: !!this.cfg.autonomousAcquisition, mode: this.cfg.autonomousAcquisitionMode ?? 'auto', gate: this.gate(),
      intent: intent ? this.viewIntent(intent) : null,
      queue: state.queue.map((item) => ({ intentId: item.intentId, title: item.title, bookKey: item.bookKey, status: item.status, notBefore: item.notBefore ?? null })),
      commitment: this.view().commitment,
      round: this.view().round,
    };
  }

  candidates(intentId: unknown): Array<Record<string, unknown>> {
    const state = this.refresh();
    const intent = state.intents.find((entry) => entry.id === intentId);
    if (!intent) throw new Error('Selection intent not found');
    return intent.candidates.slice(0, 10).map((candidate) => ({
      candidateId: candidate.id, title: candidate.title, author: candidate.author,
      source: candidate.source.name, match: candidate.match, latestChapter: candidate.latestChapter,
      expiresAt: candidate.expiresAt, available: candidate.expiresAt > this.now() && this.sourceAllowed(candidate.source.id),
    }));
  }

  detached(): SelectionSummary {
    return { enabled: !!this.cfg.autonomousAcquisition, mode: this.cfg.autonomousAcquisitionMode ?? 'auto',
      gate: { allowed: false, code: 'not-mounted', message: '阅读服务未运行。' },
      intent: null, queue: [], commitment: null, round: null };
  }

  detachedView(): SelectionView {
    const summary = this.detached();
    return { enabled: summary.enabled, mode: summary.mode, gate: summary.gate, intents: [], queue: [],
      commitment: null, round: null, cooldownUntil: null, lastOpportunityDay: null, notice: null };
  }

  compact(): SelectionSummary {
    const full = this.summary();
    return {
      ...full,
      intent: full.intent ? { id: full.intent.id, title: full.intent.title, author: full.intent.author,
        reason: full.intent.reason, status: full.intent.status, candidateCount: full.intent.candidateCount,
        createdAt: full.intent.createdAt, updatedAt: full.intent.updatedAt,
        ...(full.intent.bookKey ? { bookKey: full.intent.bookKey } : {}),
        ...(full.intent.failure ? { failure: full.intent.failure } : {}) } : null,
      queue: full.queue.slice(-3),
    };
  }

  private id(): string { return 'bookfish'; }
}
