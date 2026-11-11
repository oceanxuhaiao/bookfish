/**
 * Bookfish-owned task manager for "fetch by title".
 *
 * One engine process runs at a time; additional requests queue. A task may
 * enter the shelf only after catalog preflight, catalog re-check, text
 * completeness and the per-source page probe all pass. Failures keep their
 * evidence but never call the importer.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { labelCandidate, normalizeIdentity, type CandidateMatch, type NovelSearchCandidate } from './novel-match.ts';
import { NOVEL_SOURCES, type NovelSourceSpec } from './novel-sources.ts';
import { assessNovelDownload, composeValidatedText, isAnnouncementTitle, type CatalogChapter, type DownloadChapterFile, type NovelIntegrityIssue } from './novel-integrity.ts';
import type { NovelDownloadResult, NovelEngineAvailability } from './novel-engine.ts';
import type { NovelPageProbe } from './novel-probe.ts';
import type { RuntimeAccess } from './novel-runtime/types.ts';

export type NovelTaskState = 'queued' | 'fetching' | 'validating' | 'complete' | 'failed' | 'cancelled';
export type NovelTaskStage = 'queued' | 'catalog' | 'fetching' | 'validating' | 'importing' | 'done';

export interface NovelTaskView {
  id: string;
  state: NovelTaskState;
  stage: NovelTaskStage;
  /** Manual panel tasks stay independently retryable; autonomous tasks follow the selection gate. */
  origin: 'manual' | 'autonomous';
  title: string;
  author: string;
  source: { id: number; name: string };
  revision: string;
  catalogChapters: number;
  downloadedChapters: number;
  percent: number;
  issues: NovelIntegrityIssue[];
  issueCount: number;
  warnings: NovelIntegrityIssue[];
  warningCount: number;
  error?: string;
  bookKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NovelResumeView {
  key: string;
  title: string;
  author: string;
  source: { id: number; name: string };
  url: string;
  revision: string;
  downloadedChapters: number;
  catalogChapters: number;
  updatedAt: string;
}

export interface NovelFetchStatus {
  available: boolean;
  reason?: string;
  engineDir: string;
  engineVersion: string | null;
  pageProbe: boolean;
  activeId: string | null;
  sources: number[];
  lastSearch?: { at: string; title: string; author: string; count: number; error?: string };
  tasks: NovelTaskView[];
  /** Failed/cancelled downloads that still have chapter files and can be resumed. */
  resumable: NovelResumeView[];
}

/** Catalog preflight result for one search candidate. */
export interface NovelCandidateCheck {
  ok: boolean;
  chapters: number;
  reason?: string;
}

export interface NovelSearchJobView {
  id: string;
  /** `validating` means the search finished and candidate catalogs are being checked. */
  state: 'searching' | 'validating' | 'complete' | 'failed';
  title: string;
  author: string;
  /** Source-search progress. */
  completed: number;
  total: number;
  /** Candidate-validation progress; both stay 0 when the job does not validate. */
  checked: number;
  checkTotal: number;
  /** Candidates omitted from the final list because they failed or did not match. */
  hidden?: number;
  source?: { id: number; name: string };
  candidates?: Array<NovelSearchCandidate & { match: CandidateMatch; check?: NovelCandidateCheck }>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** CLI timeout grows with catalog length: 30 min floor, 2 h ceiling. */
export function downloadTimeoutMsFor(chapters: number): number {
  return Math.min(2 * 60 * 60_000, Math.max(30 * 60_000, Math.round(chapters * 900)));
}

/** Search-result validation: bounded pool and per-candidate catalog timeout. */
const SEARCH_CHECK_CONCURRENCY = 3;
const SEARCH_CHECK_TIMEOUT_MS = 60_000;

export interface NovelBookView {  key: string;
  title: string;
  author: string;
  totalChars: number;
  identifiedChapters: number;
}

export type NovelImporter = (file: string, metadata: { filename: string; title: string; author: string }) => { duplicate: boolean; book: NovelBookView };

/** The subset of NovelEngine used by the manager, injectable for tests. */
export interface NovelEngineLike {
  availability(): NovelEngineAvailability;
  search(query: string, options?: { signal?: AbortSignal; timeoutMs?: number; sourceIds?: number[]; onProgress?: (done: number, total: number, sourceId: number) => void }): Promise<NovelSearchCandidate[]>;
  toc(bookUrl: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<CatalogChapter[]>;
  download(candidate: NovelSearchCandidate, options?: {
    signal?: AbortSignal; timeoutMs?: number; catalogChapters?: number; onProgress?: (downloaded: number, total: number) => void; onDownloadDir?: (downloadDir: string) => void;
  }): Promise<NovelDownloadResult>;
  resume?(candidate: NovelSearchCandidate, options: {
    downloadDir: string; catalog: CatalogChapter[]; signal?: AbortSignal; timeoutMs?: number; onProgress?: (downloaded: number, total: number) => void;
  }): Promise<NovelDownloadResult>;
  preflight(identity: { title: string; author: string; sourceId: number; sourceName: string; bookUrl: string }, catalog: CatalogChapter[]): { complete: boolean; issues: NovelIntegrityIssue[] };
}

export interface NovelFetchesOptions {
  workDir: string;
  pageProbe?: NovelPageProbe | null;
  /** Book sources accepted and searched. Defaults to the curated public list. */
  sources?: readonly NovelSourceSpec[];
  /** Sources searched for this manager; defaults to the accepted sources. */
  searchSourceIds?: number[];
  /** Bound the independent page probe so a slow source cannot stall validation. */
  probeTimeoutMs?: number;
  /** Override the size-aware CLI download timeout (default 30 min..2 h). */
  downloadTimeoutMs?: number;
  /** Optional non-default ports for isolated fixture tests. */
  allowedPorts?: string[];
  maxTasks?: number;
  now?: () => number;
  /** Managed runtime; when present, every task holds a lease. */
  runtime?: RuntimeAccess;
  /** Terminal search facts for the autonomous coordinator; polling remains available to the panel. */
  onSearchDone?: (job: NovelSearchJobView) => void;
  /** Terminal acquisition facts, delivered once per task state change. */
  onTaskTerminal?: (task: NovelTaskView) => void;
}

interface InternalTask {
  id: string;
  candidate: NovelSearchCandidate;
  record: NovelTaskView;
  controller: AbortController;
  running?: Promise<void>;
  /** Download directory of a previous failed/cancelled attempt, reused for resume. */
  resumeDir?: string;
  /** Directory created for this attempt; kept even when validation fails. */
  downloadDir?: string;
}

interface ResumeEntry {
  downloadDir: string;
  title: string;
  author: string;
  source: { id: number; name: string };
  url: string;
  revision: string;
  catalogChapters: number;
  updatedAt: string;
}

function compactIssues(issues: NovelIntegrityIssue[]): NovelIntegrityIssue[] {
  return issues.slice(0, 12);
}

function countChapterFiles(dir: string): number {
  try {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) => /(?:^|[\\/])\d+_.*\.txt$/u.test(name)).length;
  } catch { return 0; }
}

function view(record: NovelTaskView): NovelTaskView {
  return { ...record, source: { ...record.source }, issues: compactIssues(record.issues), issueCount: record.issues.length, warnings: compactIssues(record.warnings), warningCount: record.warnings.length };
}

export class NovelFetches {
  private readonly tasks = new Map<string, InternalTask>();
  private readonly searchJobs = new Map<string, NovelSearchJobView>();
  private readonly queue: string[] = [];
  private activeId: string | null = null;
  private readonly sources: readonly NovelSourceSpec[];
  private readonly searchSourceIds: number[];
  private readonly allowedPorts: string[];
  private readonly maxTasks: number;
  private readonly now: () => number;
  private readonly dir: string;
  private readonly resumeIndexFile: string;
  private readonly resumeIndex = new Map<string, ResumeEntry>();
  private readonly notified = new Set<string>();
  /** Aborts panel-driven searches that are not attached to a task controller. */
  private readonly lifetime = new AbortController();
  private stopped = false;
  private lastSearch?: NovelFetchStatus['lastSearch'];

  constructor(private readonly engine: NovelEngineLike, private readonly importer: NovelImporter, private readonly options: NovelFetchesOptions) {
    this.dir = join(options.workDir, 'fetch');
    this.resumeIndexFile = join(this.dir, 'resume-index.json');
    this.sources = options.sources ?? NOVEL_SOURCES;
    this.searchSourceIds = options.searchSourceIds ?? this.sources.map((source) => source.id);
    this.allowedPorts = options.allowedPorts ?? [];
    this.maxTasks = options.maxTasks ?? 20;
    this.now = options.now ?? Date.now;
    mkdirSync(this.dir, { recursive: true });
    this.loadResumeIndex();
    this.prune();
  }

  status(): NovelFetchStatus {
    const runtime = this.options.runtime?.status();
    const availability = runtime
      ? { available: runtime.usable, ...(runtime.usable ? {} : { reason: runtime.health.message ?? '小说引擎未就绪' }), engineDir: '', version: runtime.soNovelVersion }
      : this.engine.availability();
    return {
      available: availability.available && !this.stopped,
      ...(availability.available && !this.stopped ? {} : { reason: this.stopped ? 'Bookfish is stopping' : availability.reason }),
      engineDir: availability.engineDir,
      engineVersion: availability.version,
      pageProbe: !!this.options.pageProbe,
      activeId: this.activeId,
      sources: [...this.searchSourceIds],
      ...(this.lastSearch ? { lastSearch: { ...this.lastSearch } } : {}),
      tasks: [...this.tasks.values()].sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt)).map((task) => view(task.record)).slice(0, 20),
      resumable: this.resumable(),
    };
  }

  private resumable(): NovelResumeView[] {
    const active = new Set([...this.tasks.values()]
      .filter((task) => ['queued', 'fetching', 'validating'].includes(task.record.state))
      .map((task) => this.resumeKey(task.candidate)));
    const rows: NovelResumeView[] = [];
    for (const [key, entry] of this.resumeIndex) {
      if (active.has(key) || !existsSync(entry.downloadDir)) continue;
      const downloadedChapters = countChapterFiles(entry.downloadDir);
      if (!downloadedChapters) continue;
      rows.push({
        key, title: entry.title, author: entry.author, source: { ...entry.source }, url: entry.url,
        revision: entry.revision, downloadedChapters, catalogChapters: entry.catalogChapters, updatedAt: entry.updatedAt,
      });
    }
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private engineAvailable(): { available: boolean; reason?: string } {
    const runtime = this.options.runtime?.status();
    if (runtime) return { available: runtime.usable, ...(runtime.usable ? {} : { reason: runtime.health.message ?? '小说引擎未就绪' }) };
    return this.engine.availability();
  }

  /** Search with title only, author only, or both; never requires both fields. */
  private async collectCandidates(wanted: { title?: string; author?: string }, signal?: AbortSignal, onProgress?: (done: number, total: number, sourceId?: number) => void, engine: NovelEngineLike = this.engine): Promise<Array<NovelSearchCandidate & { match: CandidateMatch }>> {
    const availability = this.engineAvailable();
    if (!availability.available) throw new Error(`Novel engine unavailable: ${availability.reason}`);
    const found = new Map<string, NovelSearchCandidate>();
    const merge = (list: NovelSearchCandidate[]) => {
      for (const candidate of list) {
        const spec = this.sourceForUrl(candidate.url);
        if (!spec) continue;
        const canonical = { ...candidate, source: { id: spec.id, name: spec.name } };
        const key = `${spec.id}|${candidate.url}`;
        if (!found.has(key)) found.set(key, canonical);
      }
    };
    let base = 0;
    const sources = this.searchSourceIds.length;
    const pass = async (query: string) => {
      const list = await engine.search(query, {
        signal, sourceIds: this.searchSourceIds,
        onProgress: (done, total, sourceId) => onProgress?.(base + done, base + total, sourceId),
      });
      base += sources;
      merge(list);
    };
    if (wanted.title) await pass(wanted.title);
    else await pass(wanted.author!);
    // A combined "title author" query is unreliable on these engines. If the
    // title pass found no exact title+author match, search the author too.
    if (wanted.title && wanted.author) {
      const hasExact = () => [...found.values()].some((candidate) => labelCandidate(candidate, wanted) === 'exact');
      if (!hasExact()) {
        onProgress?.(base, base + sources);
        await pass(wanted.author);
      }
    }
    const sourceRank = new Map(this.sources.map((source, index) => [source.id, index] as const));
    return [...found.values()]
      .map((candidate) => ({ ...candidate, match: labelCandidate(candidate, wanted) }))
      .filter((candidate) => candidate.match !== 'other')
      .sort((a, b) => matchRank(a.match) - matchRank(b.match) || (sourceRank.get(a.source.id) ?? 99) - (sourceRank.get(b.source.id) ?? 99))
      .slice(0, 30);
  }

  async search(title: string, author: string, signal?: AbortSignal): Promise<Array<NovelSearchCandidate & { match: CandidateMatch }>> {
    const wanted = { title: title.trim() || undefined, author: author.trim() || undefined };
    if (!wanted.title && !wanted.author) throw new Error('Enter a title or an author');
    const at = new Date(this.now()).toISOString();
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const lease = this.options.runtime ? await this.options.runtime.acquire() : undefined;
    try {
      const candidates = await this.collectCandidates(wanted, combined, undefined, lease?.engine);
      this.lastSearch = { at, title: wanted.title ?? '', author: wanted.author ?? '', count: candidates.length };
      return candidates;
    } catch (error) {
      this.lastSearch = { at, title: wanted.title ?? '', author: wanted.author ?? '', count: 0, error: (error as Error).message.slice(0, 500) };
      throw error;
    } finally { lease?.release(); }
  }

  /**
   * Check one exact candidate's catalog without creating a download task or
   * entering the shelf. Autonomous mode uses this to pick a source whose
   * catalog already passes the same preflight the downloader uses.
   */
  async checkCandidate(input: unknown, signal?: AbortSignal): Promise<{ ok: boolean; chapters: number; issues: NovelIntegrityIssue[]; reason?: string }> {
    const availability = this.engineAvailable();
    if (!availability.available) throw new Error(`Novel engine unavailable: ${availability.reason}`);
    const candidate = this.validateCandidate(input);
    let lease: { engine: NovelEngineLike; release: () => void } | undefined;
    try {
      lease = this.options.runtime ? await this.options.runtime.acquire() : undefined;
      return await this.probeCandidate(lease?.engine ?? this.engine, candidate, signal, 120_000);
    } finally { lease?.release(); }
  }

  /** Fetch a candidate's catalog and run the downloader's own preflight on it. */
  private async probeCandidate(engine: NovelEngineLike, candidate: NovelSearchCandidate, signal: AbortSignal | undefined, timeoutMs: number): Promise<{ ok: boolean; chapters: number; issues: NovelIntegrityIssue[]; reason?: string }> {
    try {
      const catalog = await engine.toc(candidate.url, { ...(signal ? { signal } : {}), timeoutMs });
      if (!catalog.length) return { ok: false, chapters: 0, issues: [], reason: 'Catalog is empty' };
      const preflight = engine.preflight({ title: candidate.title, author: candidate.author, sourceId: candidate.source.id, sourceName: candidate.source.name, bookUrl: candidate.url }, catalog);
      return { ok: preflight.complete, chapters: catalog.length, issues: preflight.issues,
        ...(preflight.complete ? {} : { reason: `Catalog gate rejected the edition (${catalog.length} chapters)` }) };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ok: false, chapters: 0, issues: [], reason: (error as Error).message.slice(0, 500) };
    }
  }

  /**
   * Check every acquirable candidate before the panel lists it. Mismatched
   * (title-only/author-only) results are never offered for download, so they
   * are dropped without spending a catalog request on them.
   */
  private async validateSearchCandidates(job: NovelSearchJobView, candidates: Array<NovelSearchCandidate & { match: CandidateMatch }>, engine: NovelEngineLike): Promise<void> {
    const targets = candidates.filter((candidate) => candidate.match === 'exact');
    job.state = 'validating'; job.checked = 0; job.checkTotal = targets.length;
    job.updatedAt = new Date(this.now()).toISOString();
    const checks = new Map<string, NovelCandidateCheck>();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < targets.length) {
        const candidate = targets[next++]!;
        checks.set(`${candidate.source.id}|${candidate.url}`, await this.probeCandidate(engine, candidate, this.lifetime.signal, SEARCH_CHECK_TIMEOUT_MS));
        job.checked += 1;
        job.updatedAt = new Date(this.now()).toISOString();
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEARCH_CHECK_CONCURRENCY, targets.length) }, () => worker()));
    const visible = candidates
      .map((candidate) => ({ candidate, check: checks.get(`${candidate.source.id}|${candidate.url}`) }))
      .filter((row): row is { candidate: NovelSearchCandidate & { match: CandidateMatch }; check: NovelCandidateCheck } => row.candidate.match === 'exact' && row.check?.ok === true)
      .map((row) => ({ ...row.candidate, check: row.check }));
    job.candidates = visible; job.hidden = candidates.length - visible.length; job.state = 'complete';
    job.updatedAt = new Date(this.now()).toISOString();
  }

  /** Start a pollable search job so the panel can show real per-source progress. */
  startSearch(title: string, author: string, options: { validate?: boolean } = {}): NovelSearchJobView {
    const availability = this.engineAvailable();
    if (!availability.available) throw new Error(`Novel engine unavailable: ${availability.reason}`);
    const wanted = { title: title.trim() || undefined, author: author.trim() || undefined };
    if (!wanted.title && !wanted.author) throw new Error('Enter a title or an author');
    this.pruneSearchJobs();
    const id = randomUUID();
    const now = new Date(this.now()).toISOString();
    const job: NovelSearchJobView = { id, state: 'searching', title: wanted.title ?? '', author: wanted.author ?? '', completed: 0, total: this.searchSourceIds.length, checked: 0, checkTotal: 0, createdAt: now, updatedAt: now };
    this.searchJobs.set(id, job);
    void this.runSearchJob(job, wanted, options.validate === true);
    return this.searchJobView(job);
  }

  searchStatus(id: unknown): NovelSearchJobView {
    if (typeof id !== 'string' || !id) throw new Error('Invalid novel search id');
    const job = this.searchJobs.get(id);
    if (!job) throw new Error('Novel search not found or expired');
    return this.searchJobView(job);
  }

  private searchJobView(job: NovelSearchJobView): NovelSearchJobView {
    return { ...job, ...(job.source ? { source: { ...job.source } } : {}), ...(job.candidates ? { candidates: job.candidates.map((candidate) => ({ ...candidate, source: { ...candidate.source }, ...(candidate.check ? { check: { ...candidate.check } } : {}) })) } : {}) };
  }

  private async runSearchJob(job: NovelSearchJobView, wanted: { title?: string; author?: string }, validate: boolean): Promise<void> {
    const lease = this.options.runtime ? await this.options.runtime.acquire() : undefined;
    try {
      const engine = lease?.engine ?? this.engine;
      const candidates = await this.collectCandidates(wanted, this.lifetime.signal, (done, total, sourceId) => {
        job.completed = done; job.total = total;
        if (sourceId !== undefined) job.source = { id: sourceId, name: this.sources.find((source) => source.id === sourceId)?.name ?? `source-${sourceId}` };
        job.updatedAt = new Date(this.now()).toISOString();
      }, engine);
      if (validate) {
        await this.validateSearchCandidates(job, candidates, engine);
      } else {
        job.candidates = candidates; job.state = 'complete';
      }
      job.completed = job.total;
      job.updatedAt = new Date(this.now()).toISOString();
      this.lastSearch = { at: job.createdAt, title: job.title, author: job.author, count: job.candidates?.length ?? 0 };
    } catch (error) {
      job.state = 'failed'; job.error = (error as Error).message.slice(0, 500);
      job.updatedAt = new Date(this.now()).toISOString();
      this.lastSearch = { at: job.createdAt, title: job.title, author: job.author, count: 0, error: job.error };
    } finally {
      lease?.release();
      try { this.options.onSearchDone?.(this.searchJobView(job)); } catch { /* observers must not break the task pump */ }
    }
  }

  private pruneSearchJobs(): void {
    const cutoff = this.now() - 10 * 60_000;
    for (const [id, job] of this.searchJobs) {
      if (Date.parse(job.updatedAt) < cutoff || (this.searchJobs.size > 20 && job.state !== 'searching')) this.searchJobs.delete(id);
    }
  }

  get(id: unknown): NovelTaskView {
    if (typeof id !== 'string' || !id) throw new Error('Invalid novel task id');
    const task = this.tasks.get(id);
    if (!task) throw new Error('Novel task not found');
    return view(task.record);
  }

  /** Read a task record persisted before this process started; never resumes work by itself. */
  persisted(id: string): NovelTaskView | undefined {
    if (!/^[a-f0-9-]{36}$/u.test(id)) return undefined;
    try {
      const raw = JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')) as NovelTaskView;
      if (!raw || raw.id !== id || !['queued', 'fetching', 'validating', 'complete', 'failed', 'cancelled'].includes(raw.state)) return undefined;
      return { ...raw, origin: raw.origin === 'autonomous' ? 'autonomous' : 'manual' };
    } catch { return undefined; }
  }

  start(input: unknown, origin: 'manual' | 'autonomous' = 'manual'): NovelTaskView {
    if (this.stopped) throw new Error('Bookfish is stopping');
    const availability = this.engineAvailable();
    if (!availability.available) throw new Error(`Novel engine unavailable: ${availability.reason}`);
    const candidate = this.validateCandidate(input);
    const previous = [...this.tasks.values()].find((task) => task.candidate.url === candidate.url && task.candidate.source.id === candidate.source.id &&
      ['failed', 'cancelled'].includes(task.record.state) && task.downloadDir && existsSync(task.downloadDir));
    const indexed = this.resumeIndex.get(this.resumeKey(candidate));
    const resumeDir = previous?.downloadDir ?? (indexed && existsSync(indexed.downloadDir) ? indexed.downloadDir : undefined);
    if (indexed && !existsSync(indexed.downloadDir)) this.resumeIndex.delete(this.resumeKey(candidate));
    // A new attempt for the same book hides earlier failed/cancelled attempts;
    // their JSON evidence stays on disk, but they no longer clutter the panel.
    const titleKey = normalizeIdentity(candidate.title);
    for (const [id, task] of this.tasks) {
      if (['failed', 'cancelled'].includes(task.record.state) && normalizeIdentity(task.record.title) === titleKey) this.tasks.delete(id);
    }
    const duplicate = [...this.tasks.values()].find((task) => task.candidate.url === candidate.url && task.candidate.source.id === candidate.source.id &&
      ['queued', 'fetching', 'validating'].includes(task.record.state));
    if (duplicate) return view(duplicate.record);
    if (this.tasks.size >= this.maxTasks) this.prune();
    if (this.tasks.size >= this.maxTasks) throw new Error('Too many novel fetch tasks; wait for older tasks to finish');
    const id = randomUUID();
    const now = new Date(this.now()).toISOString();
    const record: NovelTaskView = {
      id, state: 'queued', stage: 'queued', origin, title: candidate.title, author: candidate.author,
      source: { ...candidate.source }, revision: candidate.revision,
      catalogChapters: 0, downloadedChapters: 0, percent: 1, issues: [], issueCount: 0, warnings: [], warningCount: 0, createdAt: now, updatedAt: now,
    };
    const task: InternalTask = { id, candidate, record, controller: new AbortController(), ...(resumeDir ? { resumeDir } : {}) };
    this.tasks.set(id, task);
    this.persist(task);
    this.queue.push(id);
    void this.pump();
    return view(record);
  }

  cancel(id: unknown): NovelTaskView {
    if (typeof id !== 'string' || !id) throw new Error('Invalid novel task id');
    const task = this.tasks.get(id);
    if (!task) throw new Error('Novel task not found');
    if (!['queued', 'fetching', 'validating'].includes(task.record.state)) return view(task.record);
    const queued = this.queue.indexOf(id);
    if (queued >= 0) this.queue.splice(queued, 1);
    task.controller.abort();
    if (task.record.state === 'queued') {
      task.record.state = 'cancelled';
      task.record.stage = 'done';
      task.record.error = 'Cancelled before download';
      task.record.updatedAt = new Date(this.now()).toISOString();
      this.persist(task);
      this.notifyTerminal(task);
    }
    return view(task.record);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.lifetime.abort();
    for (const task of this.tasks.values()) {
      if (task.record.state === 'queued') this.cancelRecord(task, 'Bookfish stopped before download');
      else if (['fetching', 'validating'].includes(task.record.state)) task.controller.abort();
    }
    const running = [...this.tasks.values()].map((task) => task.running).filter(Boolean) as Promise<void>[];
    await Promise.allSettled(running);
  }

  private sourceForUrl(url: string): NovelSourceSpec | undefined {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return undefined; }
    return this.sources.find((source) => source.host === parsed.hostname && source.bookPath.test(parsed.pathname));
  }

  private validateCandidate(input: unknown): NovelSearchCandidate {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid novel candidate');
    const value = input as Partial<NovelSearchCandidate> & { source?: { id?: unknown; name?: unknown } };
    const text = (field: unknown, max: number): string => {
      if (typeof field !== 'string' || !field.trim() || field.length > max) throw new Error('Invalid novel candidate identity');
      return field.trim();
    };
    const title = text(value.title, 200);
    const author = text(value.author, 100);
    const url = text(value.url, 500);
    const revision = text(value.revision, 64);
    if (!/^[a-f0-9]{8,64}$/u.test(revision)) throw new Error('Invalid novel candidate revision');
    const sourceId = value.source?.id;
    if (!Number.isSafeInteger(sourceId)) throw new Error('This book source is not supported');
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('Invalid novel candidate URL'); }
    const spec = this.sourceForUrl(url);
    if (!spec) throw new Error('Novel URL is not a supported book page');
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || (parsed.port && !this.allowedPorts.includes(parsed.port)) || parsed.search || parsed.hash ||
        parsed.hostname !== spec.host || !spec.bookPath.test(parsed.pathname)) throw new Error('Novel URL is not a supported book page');
    return { title, author, url, revision, source: { id: spec.id, name: spec.name }, latestChapter: '', lastUpdateTime: '' };
  }

  private async pump(): Promise<void> {
    if (this.activeId || this.stopped) return;
    while (this.queue.length) {
      const id = this.queue.shift()!;
      const task = this.tasks.get(id);
      if (!task || task.record.state !== 'queued') continue;
      this.activeId = id;
      task.running = this.run(task).finally(() => { this.activeId = null; task.running = undefined; void this.pump(); });
      return;
    }
  }

  private async run(task: InternalTask): Promise<void> {
    const { controller } = task;
    const signal = controller.signal;
    let lease: { engine: NovelEngineLike; release: () => void } | undefined;
    try {
      lease = this.options.runtime ? await this.options.runtime.acquire() : undefined;
      const engine = lease?.engine ?? this.engine;
      const attempts: NovelSearchCandidate[] = [task.candidate];
      const tried = new Set<string>();
      const failures: Array<{ source: string; reason: string; issues: NovelIntegrityIssue[] }> = [];
      let loadedFallbacks = false;
      let firstAttempt = true;
      for (;;) {
        const candidate = task.candidate;
        tried.add(this.resumeKey(candidate));
        task.record.source = { ...candidate.source };
        task.record.revision = candidate.revision;
        task.record.catalogChapters = 0;
        task.record.downloadedChapters = 0;
        task.record.percent = 3;
        task.record.issues = [];
        task.record.issueCount = 0;
        task.record.state = 'queued';
        task.record.stage = 'catalog';
        task.record.updatedAt = new Date(this.now()).toISOString();
        if (!firstAttempt) {
          task.downloadDir = undefined;
          task.resumeDir = undefined;
        }
        firstAttempt = false;
        this.persist(task);
        try {
          const result = await this.runCandidate(task, candidate, engine, signal);
          if (result.complete) return;
          failures.push({ source: candidate.source.name, reason: result.reason ?? 'Validation failed', issues: result.issues ?? [] });
        } catch (error) {
          if (signal.aborted) return this.cancelRecord(task, 'Cancelled');
          failures.push({ source: candidate.source.name, reason: (error as Error).message.slice(0, 500), issues: [] });
        }
        if (signal.aborted) return this.cancelRecord(task, 'Cancelled');

        if (!loadedFallbacks) {
          loadedFallbacks = true;
          const alternatives = await this.findFallbackCandidates(task, engine, signal, tried);
          attempts.push(...alternatives);
        }
        const next = attempts.find((entry) => !tried.has(this.resumeKey(entry)));
        if (!next) {
          const last = failures.at(-1);
          return this.fail(task, `All ${failures.length} candidate source(s) failed; last: ${last?.reason ?? 'unknown error'}`, last?.issues ?? []);
        }
        task.record.warnings = [...task.record.warnings, {
          code: 'source_fallback',
          message: `${candidate.source.name} did not pass validation; trying ${next.source.name}`,
        }];
        task.record.warningCount = task.record.warnings.length;
        task.candidate = next;
        task.record.updatedAt = new Date(this.now()).toISOString();
        this.persist(task);
      }
    } catch (error) {
      if (signal.aborted) return this.cancelRecord(task, 'Cancelled');
      const raw = (error as Error).message;
      const timeout = raw.match(/Timed out after (\d+) ms/u);
      const message = timeout
        ? `Download timed out after ${Math.round(Number(timeout[1]) / 60_000)} minutes; nothing entered the shelf. Retry or use another source.`
        : raw;
      return this.fail(task, message);
    } finally {
      lease?.release();
    }
  }

  private async findFallbackCandidates(
    task: InternalTask,
    engine: NovelEngineLike,
    signal: AbortSignal,
    tried: Set<string>,
  ): Promise<NovelSearchCandidate[]> {
    try {
      const wanted = { title: task.record.title.trim(), author: task.record.author.trim() };
      const all = await this.collectCandidates(wanted, signal, undefined, engine);
      const currentSource = task.candidate.source.id;
      return all
        .filter((candidate) => candidate.match === 'exact' && !tried.has(this.resumeKey(candidate)))
        // Prefer a different source over another edition on the same site.
        .sort((a, b) => Number(a.source.id === currentSource) - Number(b.source.id === currentSource))
        .slice(0, 2);
    } catch {
      return [];
    }
  }

  private async runCandidate(
    task: InternalTask,
    candidate: NovelSearchCandidate,
    engine: NovelEngineLike,
    signal: AbortSignal,
  ): Promise<{ complete: boolean; reason?: string; issues?: NovelIntegrityIssue[] }> {
    const { record } = task;
    record.stage = 'catalog';
    record.percent = 3;
    this.persist(task);
    const catalog = await engine.toc(candidate.url, { signal, timeoutMs: 120_000 });
    record.catalogChapters = catalog.length;
    if (task.downloadDir) this.rememberResume(task);
    if (!catalog.length) throw new Error('Catalog is empty; download aborted');
    const identity = { title: candidate.title, author: candidate.author, sourceId: candidate.source.id, sourceName: candidate.source.name, bookUrl: candidate.url };
    const preflight = engine.preflight(identity, catalog);
    if (!preflight.complete) return { complete: false, reason: 'Catalog gate rejected the edition; nothing was downloaded', issues: preflight.issues };

    record.state = 'fetching';
    record.stage = 'fetching';
    record.percent = 5;
    if (task.resumeDir) { task.downloadDir = task.resumeDir; this.rememberResume(task); }
    this.persist(task);
    const downloadTimeoutMs = this.options.downloadTimeoutMs ?? downloadTimeoutMsFor(catalog.length);
    const onProgress = (downloaded: number, total: number) => {
      record.downloadedChapters = downloaded;
      record.catalogChapters = total || catalog.length;
      record.percent = Math.max(record.percent, Math.min(80, 5 + Math.floor(75 * downloaded / Math.max(1, record.catalogChapters))));
      record.updatedAt = new Date(this.now()).toISOString();
      this.persist(task);
    };
    const download = task.resumeDir && engine.resume
      ? await engine.resume(candidate, { downloadDir: task.resumeDir, catalog, signal, timeoutMs: downloadTimeoutMs, onProgress })
      : await engine.download(candidate, {
        signal, catalogChapters: catalog.length, timeoutMs: downloadTimeoutMs, onProgress,
        onDownloadDir: (downloadDir) => { task.downloadDir = downloadDir; this.rememberResume(task); },
      });
    task.downloadDir = download.downloadDir;
    record.downloadedChapters = download.files.length;
    if (signal.aborted) throw new Error('cancelled');
    if (download.exitCode !== 0) throw new Error(`so-novel exited with code ${download.exitCode}${download.stderrTail ? `: ${download.stderrTail}` : ''}`);

    record.state = 'validating';
    record.stage = 'validating';
    record.percent = 82;
    record.downloadedChapters = download.files.length;
    this.persist(task);
    const catalogAfter = await engine.toc(candidate.url, { signal, timeoutMs: 120_000 });
    const verdict = assessNovelDownload({
      book: identity, catalog, files: download.files, catalogAfter,
    });
    let issues = verdict.issues;
    let warnings = verdict.warnings;
    const source = this.sourceForUrl(candidate.url);
    if (this.options.pageProbe && source?.probe) {
      // An unavailable probe is a warning: the source page could not be read
      // (timeout, selector drift), but it did not prove a missing page. A
      // probe that actually finds a missing/short page remains blocking.
      const probeTimeout = this.options.probeTimeoutMs ?? Math.min(120_000, Math.max(20_000, catalog.length * 900));
      const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(probeTimeout)]);
      try {
        // Announcement pages are never part of the book; probing them would
        // compare an author note against story text.
        const probeCatalog = catalog.filter((chapter) => !isAnnouncementTitle(chapter.title));
        const probeIssues = await this.options.pageProbe.probe(source, probeCatalog, download.files, probeSignal);
        for (const issue of probeIssues) {
          if (issue.code === 'page_probe_unavailable') warnings = [...warnings, issue];
          else issues = [...issues, issue];
        }
      } catch (error) {
        if (signal.aborted) throw error;
        warnings = [...warnings, { code: 'page_probe_unavailable', message: `Page probe stopped: ${(error as Error).message}` }];
      }
    }
    if (issues.length) return { complete: false, reason: `Integrity gate rejected the download (${issues.length} issue${issues.length === 1 ? '' : 's'})`, issues };
    if (!verdict.complete) return { complete: false, reason: 'Integrity gate did not return a complete text', issues };

    record.stage = 'importing';
    record.percent = 96;
    this.persist(task);
    const validatedFile = join(download.taskDir, 'validated.txt');
    writeFileSync(validatedFile, composeValidatedText(identity, verdict.chapters), 'utf8');
    const filename = `so-novel-${candidate.source.id}-${candidate.revision}.txt`;
    const imported = this.importer(validatedFile, { filename, title: candidate.title, author: candidate.author });
    record.bookKey = imported.book.key;
    record.state = 'complete';
    record.stage = 'done';
    this.forgetResume(candidate);
    record.percent = 100;
    record.issues = [];
    record.warnings = [...record.warnings, ...warnings];
    record.warningCount = record.warnings.length;
    record.updatedAt = new Date(this.now()).toISOString();
    this.persist(task);
    this.notifyTerminal(task);
    return { complete: true };
  }
  private fail(task: InternalTask, error: string, issues: NovelIntegrityIssue[] = []): void {
    if (task.downloadDir) this.rememberResume(task);
    task.record.state = 'failed';
    task.record.stage = 'done';
    task.record.error = error.slice(0, 1000);
    task.record.issues = issues;
    task.record.issueCount = issues.length;
    task.record.updatedAt = new Date(this.now()).toISOString();
    this.persist(task);
    this.notifyTerminal(task);
  }

  private cancelRecord(task: InternalTask, error: string): void {
    if (task.record.state === 'complete' || task.record.state === 'failed') return;
    if (task.downloadDir) this.rememberResume(task);
    task.record.state = 'cancelled';
    task.record.stage = 'done';
    task.record.error = error;
    task.record.updatedAt = new Date(this.now()).toISOString();
    this.persist(task);
    this.notifyTerminal(task);
  }

  private notifyTerminal(task: InternalTask): void {
    const key = `${task.id}:${task.record.state}`;
    if (this.notified.has(key)) return;
    this.notified.add(key);
    try { this.options.onTaskTerminal?.(view(task.record)); } catch { /* event delivery is best-effort; state remains durable */ }
  }

  private resumeKey(candidate: NovelSearchCandidate): string {
    return `${candidate.source.id}|${candidate.url}`;
  }

  private loadResumeIndex(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.resumeIndexFile, 'utf8')) as Record<string, ResumeEntry>;
      for (const [key, raw] of Object.entries(parsed)) {
        if (!raw || typeof raw.downloadDir !== 'string' || !existsSync(raw.downloadDir)) continue;
        const separator = key.indexOf('|');
        const sourceId = Number(separator > 0 ? key.slice(0, separator) : 0);
        const url = separator > 0 ? key.slice(separator + 1) : '';
        const source = raw.source && Number.isSafeInteger(raw.source.id) ? raw.source : { id: sourceId, name: this.sources.find((item) => item.id === sourceId)?.name ?? `source-${sourceId}` };
        this.resumeIndex.set(key, {
          downloadDir: raw.downloadDir, title: raw.title ?? '', author: raw.author ?? '',
          source: { ...source }, url: raw.url ?? url, revision: raw.revision ?? '0000000000000000',
          catalogChapters: Number.isSafeInteger(raw.catalogChapters) ? raw.catalogChapters : 0,
          updatedAt: raw.updatedAt ?? new Date(this.now()).toISOString(),
        });
      }
    } catch { /* no index yet */ }
  }

  private saveResumeIndex(): void {
    try { writeFileSync(this.resumeIndexFile, `${JSON.stringify(Object.fromEntries(this.resumeIndex), null, 2)}\n`, 'utf8'); }
    catch { /* resume is best-effort */ }
  }

  private rememberResume(task: InternalTask): void {
    if (!task.downloadDir) return;
    this.resumeIndex.set(this.resumeKey(task.candidate), {
      downloadDir: task.downloadDir, title: task.candidate.title, author: task.candidate.author,
      source: { ...task.candidate.source }, url: task.candidate.url, revision: task.candidate.revision,
      catalogChapters: task.record.catalogChapters, updatedAt: new Date(this.now()).toISOString(),
    });
    this.saveResumeIndex();
  }

  private forgetResume(candidate: NovelSearchCandidate): void {
    if (this.resumeIndex.delete(this.resumeKey(candidate))) this.saveResumeIndex();
  }

  private persist(task: InternalTask): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${task.id}.json`), `${JSON.stringify(view(task.record), null, 2)}\n`, 'utf8');
  }

  /** Keep only the newest records; never delete an active or queued task. */
  private prune(): void {
    const finished = [...this.tasks.values()]
      .filter((task) => !this.activeId || task.id !== this.activeId)
      .filter((task) => ['complete', 'failed', 'cancelled'].includes(task.record.state))
      .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));
    while (this.tasks.size >= this.maxTasks && finished.length) {
      const removed = finished.shift()!;
      this.tasks.delete(removed.id);
      rmSync(join(this.dir, `${removed.id}.json`), { force: true });
    }
    const records = readdirSync(this.dir).filter((name) => /^[a-f0-9-]{36}\.json$/u.test(name))
      .map((name) => ({ name, time: statSync(join(this.dir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    const known = new Set([...this.tasks.keys()].map((id) => `${id}.json`));
    for (const item of records.slice(this.maxTasks)) {
      if (known.has(item.name)) continue;
      rmSync(join(this.dir, item.name), { force: true });
    }
  }
}

function matchRank(match: CandidateMatch): number {
  return match === 'exact' ? 0 : match === 'title' ? 1 : match === 'author' ? 2 : 3;
}
