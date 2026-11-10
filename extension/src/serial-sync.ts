import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SourceError, type CachedChapter, type SourceCatalog } from './source-types.ts';
import type { Library } from './library.ts';
import { BiqugeSerialAdapter } from './serial-adapter.ts';
import { cachedChapterFromSerial, diffSerialCatalog, newSerialRecord, validateSerialCatalog, SERIAL_BATCH_BYTES, SERIAL_PAGE_LIMIT,
  type SerialPublicationEvidence, type SerialReceiptStatus, type SerialSourceAdapter } from './serial-types.ts';

export type SerialJobStatus = 'queued' | 'checking' | 'fetching' | 'validating' | 'committing' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'conflict';
export interface SerialJobView { jobId: string; bookKey: string; reason: 'manual' | 'auto' | 'subscribe'; status: SerialJobStatus; stage: string;
  createdAt: string; startedAt: string | null; endedAt: string | null; discovered: number; added: number; target: number; message: string | null }
interface Job extends SerialJobView { controller: AbortController; cancelled: boolean; committing: boolean; done: Promise<void>; resolve: () => void; errorCode?: string }
interface PersistedJob { jobId: string; bookKey: string; reason: SerialJobView['reason']; status: SerialJobStatus; stage: string; createdAt: string; startedAt: string | null; endedAt: string | null; discovered: number; added: number; target: number; message: string | null }
interface Preview { token: string; adapterId: string; catalog: SourceCatalog; sourceBookId: string; expiresAt: number }
export interface SerialSyncOptions { allowNetwork: () => boolean; now?: () => number; adapter?: (id: string) => SerialSourceAdapter | null; jobsFile?: string;
  onUpdated?: (info: { bookKey: string; added: number; discovered: number }) => void }
const BACKOFF_MINUTES = [5, 15, 60, 180, 360];
const TERMINAL: SerialJobStatus[] = ['succeeded', 'failed', 'cancelled', 'interrupted', 'conflict'];
function iso(now: number) { return new Date(now).toISOString(); }
function errorMessage(error: unknown): string {
  if (error instanceof SourceError) return `${error.code}: ${error.message}`;
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
function errorCode(error: unknown): string { return error instanceof SourceError ? error.code : 'temporary'; }
function sourceBookId(bookUrl: string): string { try { return new URL(bookUrl).pathname; } catch { return bookUrl; } }

/** One serial check at a time. Network work never holds the Library write lock. */
export class SerialSync {
  private readonly jobs: Job[] = [];
  private readonly queue: string[] = [];
  private readonly previews = new Map<string, Preview>();
  private running = false;
  private started = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly adapterFor: (id: string) => SerialSourceAdapter | null;
  private readonly file: string;
  constructor(private readonly library: Library, private readonly options: SerialSyncOptions) {
    this.now = options.now ?? Date.now;
    this.adapterFor = options.adapter ?? ((id) => id === 'biquge-02345-v1' ? new BiqugeSerialAdapter() : null);
    this.file = options.jobsFile ?? join(library.dir, 'serial-jobs.json');
  }
  start(): void {
    if (this.started) return;
    this.started = true; this.stopped = false;
    if (existsSync(this.file)) {
      try {
        const saved = JSON.parse(readFileSync(this.file, 'utf8'));
        if (Array.isArray(saved)) for (const raw of saved.slice(-100) as PersistedJob[]) {
          if (!raw || typeof raw.jobId !== 'string' || typeof raw.bookKey !== 'string' || !Array.isArray(TERMINAL) || typeof raw.status !== 'string') continue;
          const done = Promise.resolve();
          this.jobs.push({ ...raw, status: raw.status === 'interrupted' ? 'interrupted' : raw.status,
            controller: new AbortController(), cancelled: raw.status === 'cancelled', committing: false, done, resolve: () => {} });
        }
      } catch { /* A corrupt job journal is preserved by the caller's logs; it is not content authority. */ }
      for (const job of this.jobs) if (!TERMINAL.includes(job.status)) { job.status = 'interrupted'; job.endedAt = iso(this.now()); job.message = '应用重启；旧任务不原样重放，请重新检查。'; }
      this.save();
    }
  }
  stop(): void {
    this.stopped = true;
    for (const job of this.jobs) if (!TERMINAL.includes(job.status)) {
      job.cancelled = true; job.controller.abort(); job.status = 'interrupted'; job.endedAt = iso(this.now()); job.message = '应用停止；未提交的正文不保留。'; job.resolve();
    }
    this.queue.length = 0; this.save();
  }
  private save(): void {
    const data: PersistedJob[] = this.jobs.slice(-100).map((job) => ({ jobId: job.jobId, bookKey: job.bookKey, reason: job.reason, status: job.status,
      stage: job.stage, createdAt: job.createdAt, startedAt: job.startedAt, endedAt: job.endedAt, discovered: job.discovered, added: job.added, target: job.target, message: job.message }));
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(data)); renameSync(temp, this.file); } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  async preview(adapterId: unknown, bookUrl: unknown, signal?: AbortSignal): Promise<{ token: string; title: string; author: string; publicationStatus: string;
    totalChapters: number; capabilities: unknown; authorization: string; authorizationNote: string; sourceId: string; note: string }> {
    const id = typeof adapterId === 'string' ? adapterId : 'biquge-02345-v1';
    if (typeof bookUrl !== 'string' || !bookUrl || bookUrl.length > 2000) throw new Error('Invalid serial book URL');
    if (!this.options.allowNetwork()) throw new SourceError('restricted', '网络访问已关闭，无法检查连载来源');
    const adapter = this.adapterFor(id);
    if (!adapter) throw new SourceError('unsupported', '此连载来源尚未适配');
    const ac = new AbortController(); const combined = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;
    const catalog = await adapter.catalog({ bookUrl, sourceBookId: sourceBookId(bookUrl) }, combined);
    validateSerialCatalog(catalog);
    const token = randomUUID();
    this.previews.set(token, { token, adapterId: id, catalog, sourceBookId: sourceBookId(bookUrl), expiresAt: this.now() + 10 * 60000 });
    while (this.previews.size > 20) this.previews.delete(this.previews.keys().next().value!);
    return { token, title: catalog.title, author: catalog.author, publicationStatus: catalog.publicationStatus, totalChapters: catalog.chapters.length,
      capabilities: adapter.capabilities, authorization: adapter.authorization, authorizationNote: adapter.authorizationNote, sourceId: id,
      note: '目录已完整读取；订阅后才开始获取正文，首章正文尚未验证。' };
  }
  subscribe(token: unknown, options: unknown = {}): { bookKey: string; duplicate: boolean; jobId: string } {
    const preview = typeof token === 'string' ? this.previews.get(token) : undefined;
    if (!preview || this.now() >= preview.expiresAt) throw new Error('连载预览已过期，请重新读取目录');
    const value = options && typeof options === 'object' && !Array.isArray(options) ? options as { enabled?: unknown; intervalMinutes?: unknown } : {};
    const enabled = value.enabled === undefined ? true : value.enabled === true;
    const interval = value.intervalMinutes === undefined ? 60 : value.intervalMinutes;
    if (typeof enabled !== 'boolean' || ![30, 60, 180, 360].includes(interval as number)) throw new Error('Invalid serial subscription options');
    const adapter = this.adapterFor(preview.adapterId);
    if (!adapter) throw new SourceError('unsupported', '此连载来源尚未适配');
    this.previews.delete(token as string);
    const serial = newSerialRecord({ serialId: randomUUID(), adapterId: adapter.id, sourceBookId: preview.sourceBookId, bookUrl: preview.catalog.bookUrl,
      capabilities: adapter.capabilities, authorization: adapter.authorization, authorizationNote: adapter.authorizationNote, catalog: preview.catalog,
      enabled, intervalMinutes: interval as number, now: this.now() });
    const created = this.library.createSerial({ catalog: preview.catalog, serial }, this.library.generation());
    this.library.select(created.book.key);
    const check = this.check(created.book.key, 'subscribe');
    return { bookKey: created.book.key, duplicate: created.duplicate, jobId: check.jobId };
  }
  check(bookKey: string, reason: 'manual' | 'auto' | 'subscribe' = 'manual'): { jobId: string; duplicate: boolean } {
    const serial = this.library.serialSubscription(bookKey);
    if (!serial) throw new Error('Serial book is not in the library');
    const active = this.jobs.find((job) => job.bookKey === bookKey && !TERMINAL.includes(job.status));
    if (active) return { jobId: active.jobId, duplicate: true };
    if (reason === 'manual' && !this.options.allowNetwork()) throw new SourceError('restricted', '网络访问已关闭，无法检查更新');
    let resolve: () => void = () => {};
    const done = new Promise<void>((res) => { resolve = res; });
    const job: Job = { jobId: randomUUID(), bookKey, reason, status: 'queued', stage: '等待执行', createdAt: iso(this.now()), startedAt: null, endedAt: null,
      discovered: 0, added: 0, target: 0, message: null, controller: new AbortController(), cancelled: false, committing: false, done, resolve };
    this.jobs.push(job); if (this.jobs.length > 200) this.jobs.splice(0, this.jobs.length - 200);
    this.queue.push(job.jobId); this.save(); void this.pump();
    return { jobId: job.jobId, duplicate: false };
  }
  cancel(jobId: unknown): { cancelled: boolean; status: SerialJobStatus; message: string } {    const job = this.jobs.find((value) => value.jobId === jobId);
    if (!job) throw new Error('Serial job was not found');
    if (TERMINAL.includes(job.status)) return { cancelled: false, status: job.status, message: '任务已经结束，不能撤销已提交的章节。' };
    if (job.committing) return { cancelled: false, status: 'committing', message: '正文已经进入提交阶段，本次无法撤销。' };
    job.cancelled = true; job.controller.abort(); job.status = 'cancelled'; job.stage = '已取消'; job.endedAt = iso(this.now());
    job.message = '提交前已取消，不新增可见章节。'; job.resolve(); this.save();
    return { cancelled: true, status: 'cancelled', message: job.message };
  }
  cancelForBook(bookKey: string): number {
    let count = 0;
    for (const job of this.jobs) if (job.bookKey === bookKey && !TERMINAL.includes(job.status)) { this.cancel(job.jobId); count++; }
    return count;
  }
  job(jobId: unknown): SerialJobView | null {
    const job = this.jobs.find((value) => value.jobId === jobId);
    return job ? this.view(job) : null;
  }
  jobsFor(bookKey: string): SerialJobView[] { return this.jobs.filter((job) => job.bookKey === bookKey).slice(-10).map((job) => this.view(job)); }
  status(): { running: boolean; active: SerialJobView | null; queued: number; jobs: SerialJobView[] } {
    const active = this.jobs.find((job) => !TERMINAL.includes(job.status) && job.status !== 'queued') ?? null;
    return { running: !!active, active: active ? this.view(active) : null, queued: this.jobs.filter((job) => job.status === 'queued').length,
      jobs: this.jobs.slice(-8).reverse().map((job) => this.view(job)) };
  }
  async wait(jobId: string, timeoutMs = 120000): Promise<SerialJobView> {
    const job = this.jobs.find((value) => value.jobId === jobId);
    if (!job) throw new Error('Serial job was not found');
    await Promise.race([job.done, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
    return this.view(job);
  }
  private view(job: Job): SerialJobView { const { controller: _controller, cancelled: _cancelled, committing: _committing, done: _done, resolve: _resolve, errorCode: _errorCode, ...view } = job; return { ...view }; }
  private finish(job: Job, status: SerialJobStatus, message: string | null): void {
    if (TERMINAL.includes(job.status) && job.status !== 'committing') { job.resolve(); return; }
    job.status = status; job.message = message; job.endedAt = iso(this.now()); job.stage = status;
    job.resolve(); this.save();
  }
  private async pump(): Promise<void> {
    if (this.running || this.stopped) return;
    const next = this.queue.shift();
    if (!next) return;
    const job = this.jobs.find((value) => value.jobId === next);
    if (!job || TERMINAL.includes(job.status)) { void this.pump(); return; }
    this.running = true;
    try { await this.run(job); } finally { this.running = false; this.save(); void this.pump(); }
  }
  private async run(job: Job): Promise<void> {
    const serial = this.library.serialSubscription(job.bookKey);
    if (!serial) { this.finish(job, 'failed', '连载条目已被删除。'); return; }
    const expectedSubscriptionRevision = serial.subscriptionRevision, expectedContentVersion = serial.contentVersion;
    const baseCatalogHash = this.library.list().find((book) => book.key === job.bookKey)?.source?.catalogHash ?? '';
    job.startedAt = iso(this.now()); job.status = 'checking'; job.stage = '读取完整目录'; this.save();
    const fail = (error: unknown, beforeCommit = true) => {
      const code = errorCode(error), message = errorMessage(error);
      if (job.cancelled || (error instanceof SourceError && error.code === 'cancelled')) { this.finish(job, 'cancelled', '提交前已取消，不新增可见章节。'); return; }
      if (beforeCommit) {
        const failures = serial.subscription.failures + 1;
        const minutes = BACKOFF_MINUTES[Math.min(failures - 1, BACKOFF_MINUTES.length - 1)];
        try { this.library.failSerialCheck(job.bookKey, expectedSubscriptionRevision, expectedContentVersion, { code, message }, this.now() + minutes * 60000); } catch { /* book may be gone */ }
      }
      this.finish(job, code === 'needs_login' || code === 'restricted' ? 'failed' : 'failed', message.slice(0, 500));
    };
    try {
      if (!this.options.allowNetwork()) throw new SourceError('restricted', '网络访问已关闭；目录和正文均未读取');
      const adapter = this.adapterFor(serial.sourceId);
      if (!adapter) throw new SourceError('unsupported', '此连载来源尚未适配');
      const binding = { bookUrl: serial.bookUrl, sourceBookId: serial.sourceBookId };
      const accepted = this.library.serialCatalog(job.bookKey);
      if (!accepted) throw new SourceError('invalid_content', '连载目录快照不可用');
      job.controller.signal.throwIfAborted();
      const catalogA = await adapter.catalog(binding, job.controller.signal);
      validateSerialCatalog(catalogA, { bookUrl: serial.bookUrl });
      job.status = 'validating'; job.stage = '比较目录'; this.save();
      const diff = diffSerialCatalog(accepted, catalogA);
      if (diff.kind === 'conflict') {
        this.library.recordSerialConflict(job.bookKey, expectedSubscriptionRevision, expectedContentVersion, diff.detail);
        this.finish(job, 'conflict', `${diff.reason}: ${diff.detail}`); return;
      }
      if (diff.kind === 'metadata_changed' && diff.changedTitles > 0) {
        this.library.recordSerialConflict(job.bookKey, expectedSubscriptionRevision, expectedContentVersion, `${diff.changedTitles} 个已接受章节的标题发生变化，需要人工确认`);
        this.finish(job, 'conflict', '已接受章节标题变化；未覆盖旧正文，已停止自动同步。'); return;
      }
      const appended = diff.kind === 'append' ? diff.appended : diff.kind === 'metadata_changed' ? diff.appended : [];
      const start = this.library.serialSubscription(job.bookKey)!.layout.length;
      const wanted = catalogA.chapters.slice(start, start + SERIAL_PAGE_LIMIT);
      job.discovered = appended.length; job.target = wanted.length; this.save();
      const chapters: CachedChapter[] = []; let bytes = 0; let fetchError: unknown = null;
      for (let i = 0; i < wanted.length; i++) {
        job.controller.signal.throwIfAborted();
        if (!this.options.allowNetwork()) throw new SourceError('restricted', '网络访问已关闭；正文同步已停止');
        job.status = 'fetching'; job.stage = `获取正文 ${chapters.length + 1}/${job.target}`; this.save();
        try {
          const chapter = await adapter.chapter(binding, wanted[i], job.controller.signal);
          if (chapter.id !== (wanted[i].id ?? wanted[i].url) || chapter.title !== wanted[i].title || chapter.url !== wanted[i].url) throw new SourceError('invalid_content', '章节身份与目录不一致');
          if (bytes + Buffer.byteLength(chapter.text) > SERIAL_BATCH_BYTES && chapters.length) break;
          chapters.push(cachedChapterFromSerial(chapter, start + chapters.length));
          bytes += Buffer.byteLength(chapter.text);
          job.added = chapters.length; this.save();
        } catch (error) {
          fetchError = error;
          if (job.cancelled || (error instanceof SourceError && error.code === 'cancelled')) throw error;
          break;
        }
      }
      job.controller.signal.throwIfAborted();
      if (!this.options.allowNetwork()) throw new SourceError('restricted', '网络访问已关闭；本批未提交');
      job.status = 'validating'; job.stage = '复核目录边界'; this.save();
      const catalogB = await adapter.catalog(binding, job.controller.signal);
      validateSerialCatalog(catalogB);
      const after = diffSerialCatalog(catalogA, catalogB);
      if (after.kind === 'conflict' || (after.kind === 'metadata_changed' && after.changedTitles > 0)) {
        this.library.recordSerialConflict(job.bookKey, expectedSubscriptionRevision, expectedContentVersion, 'A/B 目录复核发现旧章变化');
        this.finish(job, 'conflict', '复核目录与第一次快照不一致；本批未提交。'); return;
      }
      job.controller.signal.throwIfAborted();
      job.committing = true; job.status = 'committing'; job.stage = '提交快照'; this.save();
      const evidence: SerialPublicationEvidence = { status: catalogA.publicationStatus, source: adapter.id, observedAt: catalogA.fetchedAt,
        note: adapter.authorization === 'unknown' ? '来源用途授权未确认；只保存本机阅读缓存。' : '' };
      const status: SerialReceiptStatus = fetchError ? 'failed' : wanted.length === 0 ? 'no_change' : 'succeeded';
      const message = fetchError ? `新增 ${chapters.length} 章，后续同步失败：${errorMessage(fetchError)}` : null;
      const retryAt = fetchError ? new Date(this.now() + BACKOFF_MINUTES[Math.min(serial.subscription.failures, BACKOFF_MINUTES.length - 1)] * 60000).toISOString() : null;
      const result = this.library.commitSerialSync({ bookKey: job.bookKey, expectedSubscriptionRevision, expectedContentVersion, baseCatalogHash,
        catalog: catalogA, chapters, publicationEvidence: evidence, receipt: { jobId: job.jobId, status, error: message }, retryAt });
      job.added = result.receipt.addedCount; job.discovered = appended.length; job.committing = false;
      if (result.receipt.addedCount > 0) { try { this.options.onUpdated?.({ bookKey: job.bookKey, added: result.receipt.addedCount, discovered: appended.length }); } catch { /* notification is not a commit condition */ } }
      if (fetchError) this.finish(job, 'failed', message);
      else this.finish(job, 'succeeded', result.receipt.addedCount ? `新增 ${result.receipt.addedCount} 章` : '目录无变化');
    } catch (error) { job.committing = false; fail(error); }
  }
}
