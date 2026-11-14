import { readFileSync } from 'node:fs';
import { BookTransfers } from './transfers.ts';
import { Discussions, DISCUSSION_SEGMENT_COUNT, DISCUSSION_SEGMENT_LIMIT, DISCUSSION_TOTAL_LIMIT, discussionPauseMs, discussionSpokenText } from './discussions.ts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Language } from 'cortico/core/language.ts';
import type { ToolDef, World, WorldWebUiDecl, WorldHost, RunPhase, EventEnvelope, WorldLamp } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { validateSettings, type BookfishConfigSection } from './config.ts';
import { ReadingScheduler } from './scheduler.ts';
import { ReadingSharing } from './sharing.ts';
import { ReviewFlow } from './review-flow.ts';
import { Library } from './library.ts';
import { Sources } from './sources.ts';
import { requiredText } from './books.ts';
import { SourceError } from './source-types.ts';
import type { BookfishStatus } from './status.ts';
import { NovelEngine, defaultEngineDir } from './novel-engine.ts';
import { NovelFetches } from './novel-fetch.ts';
import { SourcePageProbe, type NovelPageProbe } from './novel-probe.ts';
import { SerialSync } from './serial-sync.ts';
import { SerialScheduler } from './serial-scheduler.ts';
import { NovelRuntimeManager } from './novel-runtime/manager.ts';
import { BUILTIN_RUNTIME_MANIFEST } from './novel-runtime/builtin-manifest.ts';
import { SelectionCoordinator } from './selection.ts';
import { BOOKFISH_TOOL_DECLS } from './tool-schemas.ts';
import { assertWritableTextStoreDir } from './text-store.ts';

const ENV_PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), 'ENV_PROMPT.md');
const PROTOCOL_DIR = join(dirname(fileURLToPath(import.meta.url)), 'protocol');
const PACKAGE_BRIDGE_CLASSES = join(dirname(fileURLToPath(import.meta.url)), 'novel-bridge', 'classes');
export interface BookfishWorldOptions { cfg: BookfishConfigSection; timezone: string; dataDir: string; persist?:(patch:Partial<BookfishConfigSection>)=>void;
  /** Isolated-test overrides; production defaults live under dataDir/bookfish. */
  novelEngineDir?: string; novelWorkDir?: string; novelPageProbe?: NovelPageProbe | null; novelEngine?: import('./novel-fetch.ts').NovelEngineLike;
  /** Isolated-test runtime overrides. */
  runtimeManager?: NovelRuntimeManager;
}

export class BookfishWorld implements World {
  readonly id = 'bookfish';
  private readonly discussions = new Discussions();
  private host: WorldHost | undefined;
  private readonly library: Library;
  private readonly transfers: BookTransfers;
  private readonly sources: Sources;
  private readonly scheduler: ReadingScheduler;
  private readonly sharing: ReadingSharing;
  private readonly reviewFlow: ReviewFlow;
  private readonly novelFetches: NovelFetches;
  private readonly runtime: NovelRuntimeManager;
  private readonly serialSync: SerialSync;
  private readonly serialScheduler: SerialScheduler;
  private selection!: SelectionCoordinator;
  private lifetime = new AbortController();
  constructor(private readonly opts: BookfishWorldOptions) {
    this.library = new Library({ dataDir: opts.dataDir, textStoreDir: opts.cfg.textStoreDir, storyMemoryEnabled: opts.cfg.storyMemoryEnabled === true }); this.transfers = new BookTransfers(this.library); this.sources = new Sources(this.library, undefined, () => opts.cfg.allowNetwork);
    this.scheduler = new ReadingScheduler(this.library, opts.cfg, opts.timezone, undefined, undefined,
      { autoAdvance: () => this.selection?.autoAdvance() ?? false });
    this.sharing = new ReadingSharing(this.library, opts.cfg, opts.timezone);
    this.reviewFlow = new ReviewFlow(this.library, opts.cfg);
    this.serialSync = new SerialSync(this.library, { allowNetwork: () => opts.cfg.allowNetwork,
      onUpdated: info => { void this.host?.pushEvent({ type: 'bookfish.serial_updated', ts: nowIso(opts.timezone), source: this.id, origin: 'internal', senderKey: this.id,
        text: JSON.stringify({ bookKey: info.bookKey, addedChapters: info.added, discoveredChapters: info.discovered,
          guidance: 'A serial source check added text. Do not announce it unprompted; the normal reading opportunity and user conversation decide what to read. Never infer unread plot.' }) }, { trigger: 'piggyback' }); } });
    this.serialScheduler = new SerialScheduler(this.library, this.serialSync, { allowNetwork: () => opts.cfg.allowNetwork });
    const novelWorkDir = opts.novelWorkDir ?? join(opts.dataDir, 'bookfish', 'novel-fetch');
    const engine = opts.novelEngine ?? new NovelEngine({ engineDir: opts.novelEngineDir ?? defaultEngineDir(opts.dataDir), workDir: novelWorkDir, now: Date.now });
    this.runtime = opts.runtimeManager ?? new NovelRuntimeManager({
      dataDir: opts.dataDir, workDir: novelWorkDir, bridgeClasses: PACKAGE_BRIDGE_CLASSES, manifest: BUILTIN_RUNTIME_MANIFEST,
    });
    this.novelFetches = new NovelFetches(engine, (file, metadata) => this.library.importFile(metadata, file), {
      workDir: novelWorkDir,
      pageProbe: opts.novelPageProbe === undefined ? new SourcePageProbe() : opts.novelPageProbe,
      ...(opts.runtimeManager ? { runtime: opts.runtimeManager } : opts.novelEngine ? {} : { runtime: this.runtime }),
      onSearchDone: (job) => this.selection?.onSearchDone(job),
      onTaskTerminal: (task) => this.selection?.onTaskTerminal(task),
    });
    this.selection = new SelectionCoordinator({ library: this.library, novelFetches: this.novelFetches,
      scheduler: this.scheduler, cfg: () => this.opts.cfg, timezone: opts.timezone });
  }
  private sourceSignal(signal?: AbortSignal): AbortSignal {
    if (!this.host) throw new SourceError('cancelled', 'Bookfish is not mounted');
    return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
  }
  private requireNetwork(): void {
    if (!this.opts.cfg.allowNetwork) throw new SourceError('restricted', 'Network book access is disabled; cached text remains readable');
  }
  status(): BookfishStatus {
    const available = this.host?.cognition !== undefined;
    return {
      lifecycle: this.host ? 'running' : 'stopped', stage: 'full-book-review', readingAvailable: !!this.host,
      automaticReadingAvailable: !!this.host, scheduler: this.scheduler.status(),
      cognition: !this.host ? 'not-mounted' : available ? 'available' : 'unavailable',
      selectedMode: !this.host ? 'unavailable' : this.opts.cfg.readingMode === 'auto' && available ? 'background' : 'main',
      output: 'persona-mediated', sharing: this.sharing.status(), reviewError: this.reviewFlow.error, networkEnabled: this.opts.cfg.allowNetwork, library: this.library.status(),
      novelFetch: this.novelFetches.status(),
      serial: this.serialSync.status(),
      selection: this.host ? this.selection.compact() : this.selection.detached(),
    };
  }
  envPromptVars(): Record<string, string> { return {}; }
  /**
   * Model-facing status. The panel keeps the full shape; this view omits serial
   * capability dumps, storage probes and ownership details that never change a
   * reading decision, because every field here is resent on each model request.
   */
  private modelStatus() {
    const full = this.status();
    const current = full.library.current;
    const s = full.scheduler;
    return {
      lifecycle: full.lifecycle, readingAvailable: full.readingAvailable, automaticReadingAvailable: full.automaticReadingAvailable,
      selectedMode: full.selectedMode, cognition: full.cognition, networkEnabled: full.networkEnabled, reviewError: full.reviewError,
      output: full.output,
      scheduler: { routine: s.routine, enabled: s.enabled, reason: s.reason, error: s.error, charsPerMinute: s.charsPerMinute,
        pacedChars: s.pacedChars, nextAt: s.nextAt, restUntil: s.restUntil, active: s.active, manual: s.manual,
        goal: s.goal, budget: s.budget, rest: s.habits.rest ? { plannedUntil: s.habits.rest.plannedUntil, source: s.habits.rest.source, state: s.habits.rest.state } : null,
        sessionReadMs: s.habits.readMs, hostPhase: s.hostPhase },
      library: { mounted: full.library.mounted, paused: full.library.paused, providedChars: full.library.providedChars,
        pending: full.library.pending, textStoreError: full.library.textStore?.error ?? null,
        current: current ? { key: current.key, title: current.title, author: current.author, revision: current.revision,
          chapter: current.chapter, totalChars: current.totalChars, totalSegments: current.totalSegments,
          confirmedChars: current.confirmedChars, confirmedSegments: current.confirmedSegments, progress: current.progress,
          progressUnit: current.progressUnit, complete: current.complete, readiness: current.readiness,
          chapterGoalSupported: current.chapterGoalSupported } : null },
      sharing: this.sharing.summary(),
    };
  }
  tools(): ToolDef[] {
    const handlers: Record<string, (args: Record<string, unknown>, signal?: AbortSignal) => unknown> = {
      bookfish_begin_review: args => this.library.beginReview(args), bookfish_review_materials: args => this.library.reviewMaterials(args),
      bookfish_finish_review: args => this.library.finishReview(args), bookfish_fail_review: args => this.library.failReview(args),
      bookfish_list_reviews: args => this.library.reviews(args.bookKey), bookfish_get_review: args => this.library.review(args.reviewId), bookfish_reply_discussion: args => this.discussions.reply(args), bookfish_pace_discussion: async args => { const segment = requiredText(args.previousSegment, 'previousSegment', 200); const chars = Array.from(discussionSpokenText(segment)).length; if (!chars) throw new Error('previousSegment has no spoken text'); const waitMs = discussionPauseMs(chars); await new Promise(resolve => setTimeout(resolve, waitMs)); return { waitedMs: waitMs }; },
      bookfish_propose_share: args => this.sharing.propose(args), bookfish_get_sharing: () => this.sharing.status(),
      bookfish_claim_share: args => this.sharing.claim(args), bookfish_report_share: args => this.sharing.report(args),
      bookfish_drop_share: args => this.sharing.drop(args.shareId),
      bookfish_get_status: () => this.modelStatus(), bookfish_list_books: () => this.library.list(),
      bookfish_select_book: (args) => { const result = this.library.select(args.bookKey); this.scheduler.changed(); this.selection.onSelectionChanged(String(args.bookKey)); return result; },
      bookfish_read_next: async (args, signal) => {
        this.scheduler.authorize(args.opportunityId);
        const current = this.library.status().current;
        if (current?.serial && current.readiness !== 'backlog') return { complete: false, waiting: current.readiness,
          bookKey: current.key, message: current.readiness === 'caught_up' ? '已读到当前目录末尾，等待更新；这不是全书完读。' : current.readiness === 'waiting_content' ? '目录已发现新章，正文尚未同步完成，请等待。' : '连载来源存在冲突，暂停自动读取。' };
        const combined = this.sourceSignal(signal);
        if (this.library.sourceDemand()?.needsNext) {
          this.requireNetwork(); await this.sources.ensureNext(combined);
        }
        combined.throwIfAborted(); return this.scheduler.read(args.opportunityId, args.segments);
      }, bookfish_finish_reading: (args) => {
        // The model often drops opportunityId; the active task is enough to authorize its own confirmation.
        const active = this.scheduler.status().active;
        const opportunityId = args.opportunityId === undefined && active?.opportunityId ? active.opportunityId : args.opportunityId;
        if (Array.isArray(args.confirmations)) return this.scheduler.finishBatch(opportunityId, args.confirmations, args.episode);
        return this.scheduler.finish(opportunityId === undefined ? args : { ...args, opportunityId });
      },
      bookfish_search_reading: (args) => this.library.search(args),
      bookfish_get_reading_context: (args) => this.library.context(args),
      bookfish_list_journal: (args) => this.library.journal(args.bookKey, args.before, args.limit),
      bookfish_get_episode: (args) => this.library.episode(args.episodeId),
      bookfish_record_reflection: (args) => this.library.reflect(args),
      bookfish_defer_reading: (args) => this.scheduler.defer(args.opportunityId, args.minutes),
      bookfish_set_paused: (args) => { const result = this.library.setPaused(args.paused); this.scheduler.changed(); return result; },
      bookfish_recall_segment: (args) => this.library.reread(args.bookKey, args.segmentId),
      bookfish_resolve_source: async (args, signal) => {
        const combined = this.sourceSignal(signal); this.requireNetwork();
        return this.sources.resolve(requiredText(args.url, 'url', 2000), combined);
      },
      bookfish_find_book: (args) => args.intentId !== undefined
        ? { ...this.selection.summary(args.intentId), candidates: this.selection.candidates(args.intentId) }
        : this.selection.startSearch(args),
      bookfish_acquire_book: (args) => this.selection.acquireCandidate(args.candidateId),
      bookfish_get_acquisition: (args) => args.intentId !== undefined
        ? { ...this.selection.summary(args.intentId), candidates: this.selection.candidates(args.intentId) }
        : this.selection.summary(),
      bookfish_plan_reading: (args) => this.selection.plan(args.intentId, args.action, args.notBefore),
    };
    const grouped: Record<string, (args: Record<string, unknown>, signal?: AbortSignal) => unknown> = {
      bookfish_lookup: (args) => {
        switch (String(args.action)) {
          case 'search': return handlers.bookfish_search_reading(args);
          case 'context': return handlers.bookfish_get_reading_context(args);
          case 'episode': return handlers.bookfish_get_episode(args);
          case 'journal': return handlers.bookfish_list_journal(args);
          case 'recall': return handlers.bookfish_recall_segment(args);
          case 'story': {
            const bookKey = requiredText(args.bookKey, 'bookKey', 150);
            const atFrontier = args.atFrontier === undefined ? undefined : Number(args.atFrontier);
            if (atFrontier !== undefined && (!Number.isSafeInteger(atFrontier) || atFrontier < 0)) throw new Error('atFrontier must be a non-negative integer');
            switch (String(args.storyAction ?? 'overview')) {
              case 'overview': return this.library.storyOverview(bookKey, atFrontier, args.limit === undefined ? 20 : Number(args.limit), args.cursor === undefined ? undefined : String(args.cursor));
              case 'evidence': {
                if (!Array.isArray(args.eventIds) || args.eventIds.length > 8) throw new Error('eventIds must contain at most 8 ids');
                return this.library.storyEvidence(bookKey, args.eventIds.map(String), atFrontier);
              }
              case 'entity': return this.library.storyEntityCandidates(bookKey, requiredText(args.query, 'query', 160), atFrontier);
              default: throw new Error('storyAction must be overview, evidence or entity');
            }
          }
          default: throw new Error('bookfish_lookup action must be search, context, episode, journal, recall or story');
        }
      },
      bookfish_acquire: (args, signal) => {
        switch (String(args.action)) {
          case 'resolve': return handlers.bookfish_resolve_source(args, signal);
          case 'find': return handlers.bookfish_find_book(args);
          case 'start': return handlers.bookfish_acquire_book(args);
          case 'status': return handlers.bookfish_get_acquisition(args);
          case 'plan': return this.selection.plan(args.intentId, args.planAction, args.notBefore);
          default: throw new Error('bookfish_acquire action must be resolve, find, start, status or plan');
        }
      },
      bookfish_share: (args) => {
        switch (String(args.action)) {
          case 'propose': return handlers.bookfish_propose_share(args);
          case 'status': return this.sharing.page(args.limit, args.cursor);
          case 'drop': return handlers.bookfish_drop_share(args);
          case 'report': return handlers.bookfish_report_share(args);
          default: throw new Error('bookfish_share action must be propose, status, drop or report');
        }
      },
      bookfish_review: (args) => {
        switch (String(args.action)) {
          case 'begin': return handlers.bookfish_begin_review(args);
          case 'materials': return handlers.bookfish_review_materials(args);
          case 'finish': return handlers.bookfish_finish_review(args);
          case 'fail': return handlers.bookfish_fail_review(args);
          case 'list': return handlers.bookfish_list_reviews(args);
          case 'get': return handlers.bookfish_get_review(args);
          case 'story': {
            if (!Array.isArray(args.storyChanges)) throw new Error('story action needs storyChanges[]');
            return this.library.captureStory({ bookKey: args.bookKey, requestId: args.requestId, changes: args.storyChanges });
          }
          default: throw new Error('bookfish_review action must be begin, materials, finish, fail, list, get or story');
        }
      },
      bookfish_discussion: (args) => {
        switch (String(args.action)) {
          case 'append': return this.discussions.append(args);
          case 'reply': return handlers.bookfish_reply_discussion(args);
          case 'pace': return handlers.bookfish_pace_discussion(args);
          default: throw new Error('bookfish_discussion action must be append, reply or pace');
        }
      },
      bookfish_help: (args) => this.help(args.topic),
    };
    return BOOKFISH_TOOL_DECLS.map((decl) => ({ ...decl, handler: async (args, call) => {
      if (call.signal?.aborted) throw new Error('Bookfish request was cancelled');
      const fn = (handlers as Record<string, (a: Record<string, unknown>, s?: AbortSignal) => unknown>)[decl.name] ?? grouped[decl.name];
      if (!fn) throw new Error(`Unknown Bookfish tool: ${decl.name}`);
      return JSON.stringify(await fn(args, call.signal));
    } }));
  }
  private help(topic: unknown): string {
    const name = requiredText(topic, 'topic', 40);
    const allowed = ['reading', 'journal', 'retrieval', 'sharing', 'review', 'selection', 'discussion', 'story'];
    if (!allowed.includes(name)) throw new Error(`Unknown protocol topic; use one of ${allowed.join(', ')}`);
    return readFileSync(join(PROTOCOL_DIR, `${name}.md`), 'utf8');
  }
  private readingLamp(en: boolean): WorldLamp {
    const status = this.library.status();
    const label = en ? 'Reading' : '阅读';
    if (!this.host) return { label, state: 'offline', hint: en ? 'Bookfish is not mounted' : '扩展未挂载' };
    if (status.textStore?.error) return { label, state: 'error', hint: en ? `Full-text folder unavailable: ${status.textStore.error}` : `全文目录不可用：${status.textStore.error}` };
    if (status.paused) return { label, state: 'offline', hint: en ? 'Reading is paused' : '阅读已暂停' };
    if (!status.current) return { label, state: 'online', hint: en ? 'No current book' : '书架空着，没有正在读的书' };
    return { label, state: 'online', hint: en ? `Reading “${status.current.title}”` : `正在读《${status.current.title}》` };
  }
  webUi(language?: Language): WorldWebUiDecl {
    const en = language !== undefined && language !== 'zh' && language !== 'zh-Hant';
    return {
      label: en ? 'Bookfish' : '看书吧！大肥鱼',
      lamps: [this.readingLamp(en)],
      panels: [{id:'status',title:en?'Reading now':'正在读',getMethods:['runtime_status']},{id:'shelf',title:en?'Bookshelf':'书架',getMethods:['runtime_status']},{id:'trail',title:en?'Reading journal':'阅读足迹'},{id:'support',title:en?'Feedback':'反馈'},{id:'settings',title:en?'Settings':'配置',getMethods:['runtime_status']}],
      invoke: async (panel, method, args) => {
        if (panel==='settings'||panel==='shelf'||panel==='status') {
          if (method==='runtime_status'&&args.length===0) return this.runtime.status();
          if (method==='runtime_install'&&args.length<=1) return this.runtime.installOnline(args[0]);
          if (method==='runtime_cancel'&&args.length===0) return this.runtime.cancel() ?? this.runtime.status();
          if (method==='runtime_probe'&&args.length===0) return this.runtime.probe();
          if (method==='runtime_check_source'&&args.length===0) return this.runtime.checkSource();
          if (method==='runtime_download_info'&&args.length===0) return this.runtime.downloadInfo();
          if (method==='runtime_check_update'&&args.length===0) return this.runtime.checkUpdate();
          if (method==='runtime_rollback'&&args.length===0) return this.runtime.rollback();
          if (method==='runtime_uninstall'&&args.length===0) return this.runtime.uninstall();
          if (method==='runtime_import_begin'&&args.length===1) return this.runtime.importBegin(args[0]);
          if (method==='runtime_import_chunk'&&args.length===3) return this.runtime.importChunk(args[0],args[1],args[2]);
          if (method==='runtime_import_finish'&&args.length===1) return this.runtime.importFinish(args[0]);
          if (method==='runtime_import_cancel'&&args.length===1) return this.runtime.importCancel(args[0]);
        }
        if(panel==='settings'){
          if(method==='get'&&args.length===0)return {config:{...this.opts.cfg},timezone:this.opts.timezone,storage:this.library.textStoreStatus()};
          if(method==='save'&&args.length===1){const patch=validateSettings(args[0]);if(patch.textStoreDir!==undefined)patch.textStoreDir=assertWritableTextStoreDir(patch.textStoreDir);if(!this.opts.persist)throw Error('Host settings persistence unavailable');this.opts.persist(patch);this.selection.onConfigChanged();return {config:{...this.opts.cfg},timezone:this.opts.timezone,storage:this.library.textStoreStatus()};}
          throw Error('Unsupported settings method');
        }
        if (!['status','shelf','trail'].includes(panel) || !Array.isArray(args)) throw new Error('Unsupported Bookfish panel');
        // The WebUI keeps polling transfer_status while the extension panel is
        // open. After the World is disabled the host is gone, so report "no
        // import job" instead of throwing on every poll.
        if (method === 'transfer_status' && args.length <= 1) return this.host ? this.transfers.status(args[0]) : null;
        if(this.host){if(method==='upload_begin'&&args.length===1)return this.transfers.begin(args[0]);if(method==='upload_chunk'&&args.length===3)return this.transfers.chunk(args[0],args[1],args[2]);if(method==='upload_finish'&&args.length===1)return this.transfers.start(args[0]);if(method==='transfer_cancel'&&args.length===1)return this.transfers.cancel(args[0]);if(method==='backup_begin'&&args.length===0)return this.transfers.download();if(method==='backup_read'&&args.length===2)return this.transfers.read(args[0],args[1]);}
        if (method === 'get' && args.length === 0) return { discussions: this.discussions.list(), config: { ...this.opts.cfg }, status: this.status(), books: this.host ? this.library.list() : [], journal: this.host && this.library.status().current ? this.library.journal() : null, reviews: this.host && this.library.status().current ? this.library.reviews() : null, novel: this.novelFetches.status(), serial: this.serialSync.status(), selection: this.host ? this.selection.view() : this.selection.detachedView() };
        if (!this.host) throw new Error('Bookfish is not mounted');
        if (method === 'book' && args.length === 1) { const key = requiredText(args[0], 'bookKey', 150); const book = this.library.list().find(b=>b.key===key); if (!book) throw new Error('Book not found'); return { book, journal: this.library.journal(key), reviews: this.library.reviews(key) }; }
        if (method === 'timeline' && args.length === 1) { const o = args[0] as { bookKey?: unknown; before?: unknown }; if (!o || typeof o !== 'object') throw new Error('Invalid timeline request'); return this.library.timeline(o.bookKey, o.before); }
        if (method === 'novel_status' && args.length === 0) return this.novelFetches.status();
        if (method === 'selection_summary' && args.length <= 1) return this.selection.summary(args[0]);
        if (method === 'selection_acquire_candidate' && args.length === 1) return this.selection.acquireCandidate(args[0]);
        if (method === 'selection_cancel' && args.length === 1) return this.selection.cancel(args[0]);
        if (method === 'selection_abandon' && args.length === 1) { const result = this.selection.abandon(args[0]); this.scheduler.changed(); return result; }
        if (method === 'novel_search_start' && args.length === 1) {
          this.requireNetwork();
          if (!this.host) throw new Error('Bookfish is not mounted');
          const o = args[0];
          if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Invalid novel search');
          const value = o as { title?: unknown; author?: unknown };
          const optional = (field: unknown, name: string, max: number): string => {
            if (field === undefined || field === null) return '';
            if (typeof field !== 'string' || field.length > max) throw new Error(`Invalid ${name}`);
            return field.trim();
          };
          const title = optional(value.title, 'title', 200);
          const author = optional(value.author, 'author', 100);
          if (!title && !author) throw new Error('Enter a title or an author');
          return this.novelFetches.startSearch(title, author, { validate: true });
        }
        if (method === 'novel_search_status' && args.length === 1) return this.novelFetches.searchStatus(args[0]);
        if (method === 'novel_search' && args.length === 1) {
          this.requireNetwork();
          if (!this.host) throw new Error('Bookfish is not mounted');
          const o = args[0];
          if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Invalid novel search');
          const value = o as { title?: unknown; author?: unknown };
          const optional = (field: unknown, name: string, max: number): string => {
            if (field === undefined || field === null) return '';
            if (typeof field !== 'string' || field.length > max) throw new Error(`Invalid ${name}`);
            return field.trim();
          };
          const title = optional(value.title, 'title', 200);
          const author = optional(value.author, 'author', 100);
          if (!title && !author) throw new Error('Enter a title or an author');
          return { candidates: await this.novelFetches.search(title, author, this.sourceSignal()) };
        }
        if (method === 'novel_fetch' && args.length === 1) { if (!this.host) throw new Error('Bookfish is not mounted'); this.requireNetwork(); return this.novelFetches.start(args[0]); }
        if (method === 'novel_task' && args.length === 1) return this.novelFetches.get(args[0]);
        if (method === 'novel_cancel' && args.length === 1) return this.novelFetches.cancel(args[0]);
        if (method === 'serial_preview' && args.length === 1) {
          this.requireNetwork(); if (!this.host) throw new Error('Bookfish is not mounted');
          const value = args[0];
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid serial preview');
          const input = value as { url?: unknown; sourceId?: unknown };
          return this.serialSync.preview(input.sourceId, input.url, this.sourceSignal());
        }
        if (method === 'serial_subscribe' && (args.length === 1 || args.length === 2)) {
          if (!this.host) throw new Error('Bookfish is not mounted');
          return this.serialSync.subscribe(args[0], args[1]);
        }
        if (method === 'serial_check' && args.length === 1) {
          this.requireNetwork(); if (!this.host) throw new Error('Bookfish is not mounted');
          return this.serialSync.check(requiredText(args[0], 'bookKey', 150), 'manual');
        }
        if (method === 'serial_job' && args.length === 1) return this.serialSync.job(args[0]);
        if (method === 'serial_jobs' && args.length <= 1) return args.length ? this.serialSync.jobsFor(requiredText(args[0], 'bookKey', 150)) : this.serialSync.status();
        if (method === 'serial_cancel' && args.length === 1) return this.serialSync.cancel(args[0]);
        if (method === 'serial_set_subscription' && (args.length === 2 || args.length === 3)) {
          if (!this.host) throw new Error('Bookfish is not mounted');
          const key = requiredText(args[0], 'bookKey', 150);
          this.serialSync.cancelForBook(key);
          const result = this.library.setSerialSubscription(key, args[1], args[2]);
          return result;
        }
        if (method === 'detect' && args.length === 1) { this.requireNetwork(); return this.sources.detect(requiredText(args[0], 'url', 2000), this.sourceSignal()); }
        if (method === 'accept_source' && args.length === 1) return this.sources.accept(args[0]);
        if (method === 'discuss' && args.length === 1) {
          const o = args[0] as { episodeId?: unknown; text?: unknown }; if (!o || typeof o !== 'object') throw new Error('Invalid discussion');
          const { episode, book } = this.library.episode(o.episodeId); const question = requiredText(o.text, 'text', 2000);
          // Like the official console: this invoke is an explicit local WebUI operator message, not imported novel text.
          const discussion=this.discussions.create(book.key,episode.id,question);
          let event;try { event = await this.host.pushEvent({ source: this.id, ts: nowIso(this.opts.timezone), type: 'bookfish.discussion', origin: 'internal', senderKey: 'bookfish-user', text: JSON.stringify({ discussionId: discussion.id, userQuestion: question, bookKey: book.key, episodeId: episode.id, guidance: `User asks to discuss this saved episode. Retrieve its confirmed source/context. Answer on the desktop pet as a friend, not only in the reading panel. Split the answer into 1-${DISCUSSION_SEGMENT_COUNT} chat bubbles by meaning and breath, not by character count. Keep one complete sentence together even when it has several comma-linked clauses; never split a sentence merely to make it shorter. Start a new bubble only at a real sentence boundary or a clear change of thought. Each bubble may be up to ${DISCUSSION_SEGMENT_LIMIT} code points and the whole reply up to ${DISCUSSION_TOTAL_LIMIT}; if a sentence is too long, shorten it instead of cutting it. Never cut a name or clause with an ellipsis; if unsure of a name, describe the person instead of writing "库...". Call pet_say once per bubble in order and wait for each call to succeed. Immediately after each successful pet_say, call bookfish_discussion(action="append") with discussionId and segment set to the exact spoken line, so the panel can show it before the next bubble. After each bubble except the last, call bookfish_discussion(action="pace") with that exact previous segment and wait for it to return before the next pet_say; this only adds a gap between bubbles, never changes the typing speed. Then call bookfish_discussion(action="reply") with this discussionId, delivery "spoken", and all exact segments in the same order; the panel only mirrors what you actually said. If pet_say is missing or any call fails, do not invent spoken lines: call bookfish_discussion(action="reply") with delivery "unavailable" and a short reason. Unread plot can only be an explicitly labelled guess; do not read ahead or invent past feelings.` }) }, { trigger: 'flush' }); } catch(error) {this.discussions.cancel(discussion.id);throw error;}
          return { accepted: true, cursor: event.cursor, discussionId: discussion.id };
        }
        if(method==='read_now'&&args.length===1)return this.scheduler.requestNow(args[0]);
        if (method === 'request_review' && args.length === 0) return this.reviewFlow.request();
        if (method === 'cancel_review' && args.length === 1) return this.library.failReview({ jobId: args[0], reason: 'User cancelled this attempt' });
        if (method === 'review' && args.length === 1) return this.library.review(args[0]);
        if (method === 'export_shares' && args.length === 0) return this.sharing.exportHistory();
        if (method === 'share_visible' && args.length === 1) return this.sharing.visible(args[0]);
        if (method === 'share_drop' && args.length === 1) return this.sharing.drop(args[0]);
        if (method === 'journal' && args.length === 1) {
          const options = args[0] as { bookKey?: unknown; before?: unknown; limit?: unknown };
          if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid journal options');
          return this.library.journal(options.bookKey, options.before, options.limit);
        }
        if ((method === 'search' || method === 'context') && args.length === 1) {
          const options = args[0];
          if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid retrieval options');
          return method === 'search' ? this.library.search(options as Record<string, unknown>) : this.library.context(options as Record<string, unknown>);
        }
        if (method === 'episode' && args.length === 1) return this.library.episode(args[0]);
        if (method === 'import' && args.length === 1) return this.library.import(args[0]);
        if (method === 'resolve' && args.length === 1) {
          this.requireNetwork(); return this.sources.resolve(requiredText(args[0], 'url', 2000), this.sourceSignal());
        }
        if (method === 'fetch' && args.length === 0) {
          this.requireNetwork(); await this.sources.ensureNext(this.sourceSignal()); return this.status();
        }
        if (method === 'reader' && args.length === 1) return this.library.reader(args[0]);
        if (method === 'select' && args.length === 1) { const result = this.library.select(args[0]); this.scheduler.changed(); this.selection.onSelectionChanged(String(args[0])); return result; }
        if (method === 'pause' && args.length === 1) { const result = this.library.setPaused(args[0]); this.scheduler.changed(); return result; }
        if (method === 'resume_rest' && args.length === 0) return this.scheduler.resume();
        if (method === 'remove' && args.length === 1) { this.serialSync.cancelForBook(String(args[0])); const result = this.library.remove(args[0]); this.discussions.removeBook(String(args[0])); this.scheduler.changed(); this.sharing.status(); this.selection.summary(); return result; }
        if (method === 'export' && args.length === 0) return this.library.export();
        if (method === 'restore' && args.length === 1) return this.library.restore(args[0]);
        throw new Error('Unsupported Bookfish panel request');
      },
      storage: [{ key: 'bookfish-library', label: en ? 'Books, progress and reading journal' : '书籍、已读进度与阅读手账', kind: 'disk', location: this.library.dir,
        stat: () => this.host ? `${this.library.list().length} book revisions` : 'Not mounted',
        danger: true,
        note: en ? 'Clears all Bookfish books, progress and journal entries. Export a backup first. Persona Memory is untouched.' : '清除本扩展全部书籍、阅读进度和手账，请先导出备份。不改变 Persona Memory。',
        clear: () => { this.transfers.close(); for (const book of this.library.list()) this.serialSync.cancelForBook(book.key); const result = this.library.clear(); this.discussions.clear(); this.scheduler.changed(); this.sharing.status(); return result; },
      }, { key: 'bookfish-sharing', label: en ? 'Share history (budget retained)' : '分享文本与历史（保留尝试预算）', kind: 'disk', location: this.library.dir, danger: true,
        stat: () => `${this.sharing.status().total} shares`, note: en ? 'Clears share text; hashed deduplication and budget remain. Not included in library backups.' : '清除分享文本；保留去重摘要及尝试预算。书架备份不包含分享历史。', clear: () => this.sharing.clearHistory() }],
      promptDocs: [{ key: 'worlds.bookfish.envPrompt', title: en ? 'Bookfish environment' : '阅读环境提示词',
        description: en ? 'Reading protocol and external text boundaries.' : '阅读协议与外部正文边界。', path: ENV_PROMPT_FILE, role: 'envPrompt' }],
    };
  }
  async start(host: WorldHost): Promise<void> {
    if (this.host) return;
    this.library.open();try{this.transfers.recover();}catch(error){this.library.close();throw error;} this.host = host; this.lifetime = new AbortController();
    try {
      try { await this.runtime.start(); } catch { /* runtime faults stay inside the runtime card, not the whole World */ }
      this.scheduler.start(host);
      this.sharing.start(host);
      this.reviewFlow.start(host);
      this.selection.start(host);
      this.serialSync.start();
      this.serialScheduler.start();
      await host.pushEvent({ type: 'bookfish.started', ts: nowIso(this.opts.timezone), source: this.id,
        origin: 'internal', senderKey: this.id,
        text: 'Bookfish library mounted. Previous pending reading tasks were cancelled. Automatic reading is opt-in; sharing uses the saved user configuration. Saved sharing reservations with no reliable result become unknown, never retried. Use bookfish_get_status for reading and sharing gates. Output is Persona-mediated; a tool receipt is not proof of visible display.',
      }, { trigger: 'piggyback' });
    } catch (error) {
      try { await this.selection.stop(); this.serialScheduler.stop(); this.serialSync.stop(); this.reviewFlow.stop(); this.sharing.stop(); this.scheduler.stop(); await this.novelFetches.stop(); await this.runtime.stop(); } finally { this.lifetime.abort(); this.host = undefined; this.library.close(); }
      throw error;
    }
  }
  onRunPhase(phase: RunPhase): void { this.scheduler.onRunPhase(phase); this.selection.onRunPhase(phase); this.sharing.onRunPhase(phase); this.reviewFlow.onRunPhase(phase); }
  onTurnEnded(): void { this.scheduler.onTurnEnded(); this.sharing.onTurnEnded(); }
  onEventsSettled(events: readonly EventEnvelope[], outcome: 'delivered' | 'discarded'): void { this.scheduler.onEventsSettled(events, outcome); this.sharing.onEventsSettled(events, outcome); }
  async stop(): Promise<void> {
    try { await this.selection.stop(); this.serialScheduler.stop(); this.serialSync.stop(); this.reviewFlow.stop(); this.sharing.stop(); this.scheduler.stop(); await this.novelFetches.stop(); await this.runtime.stop(); } finally { await this.transfers.shutdown(); this.discussions.clear(); this.lifetime.abort(); this.library.close(); this.host = undefined; }
  }
}

