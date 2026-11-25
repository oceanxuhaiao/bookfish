import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, copyFileSync, readdirSync, lstatSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WriterLock } from './writer-lock.ts';
import { HistoryStore, historyFork, historySelect, historyFind, historyPage, historyCount, isHistory, plainHistory, type HistoryRef, type HistoryFilter } from './history.ts';
import { browseItem, browseWindow, footprintMatches, parseBrowseQuery, parseNewQuery, parseProbeQuery, type BrowseOrder, type BrowseQuery, type BrowsePage, type BrowseBooks, type BrowseProbe, type BrowseNew } from './journal-browse.ts';
import { BookStorage, type ArchiveHooks } from './book-storage.ts';import { isPagedBook, chapterSpan, chapterEndIds, remoteLayout, readerChapters } from './paged-book.ts';
import { buildBook, decodeFile, digest, requiredText, type Book } from './books.ts';
import { BestEffortRejected } from './stream-import.ts';
import type { BestEffortDecoded } from './stream-import.ts';
import { assessText } from './txt-acquisition/quality.ts';
import { searchReading, readingContext } from './retrieval.ts';
import { beginReview, reviewMaterials, finishReview, failReview, validateReviews, type BookReview, type ReviewJob } from './reviews.ts';
import { normalizeEpisode, validateEpisodes, evidenceView, record, MAX_EPISODES, type ReadingEpisode } from './journal.ts';
import { buildRemoteBook, buildSerialBook } from './remote-books.ts';
import { SourceError, type CachedChapter, type SourceCatalog } from './source-types.ts';
import { SERIAL_INTERVALS, SERIAL_PAGE_LIMIT, chapterId, nextCheckIso, receiptFor, stableSerialIdentity, validateSerialCatalog, validateSerialRecord, type SerialCatalogCommit, type SerialPublicationEvidence, type SerialReceipt, type SerialRecord, type SerialSyncCommit } from './serial-types.ts';
import { emptySelection, validateSelection, type SelectionState } from './selection-types.ts';
import { PLAN_ARCHIVE_LIMIT } from './reading-plan.ts';
import { addPlanItems, archiveItem, createSeries, dropUnusedSeries, emptyPlan, findItem, markStarted, migrateLegacyQueue, movePlanItem, movePlanSeries, reconcilePlan, setItemNotBefore, setItemSeries, setPlanEnabled, suggestSeries, validatePlan, type PlanAddInput, type PlanItem, type PlanSource, type ReadingPlan } from './reading-plan.ts';
import { PlanCoordinator, type PlanAdvanceResult, type PlanSchedulerView } from './plan-coordinator.ts';
import { addBatchItems, recordRejected, trimBatches, validateBatches, type BatchAddResult, type ImportBatch, type BatchItemInput } from './import-batch.ts';
import { StoryStore, type StoryChange, type StoryPackInput } from './story/store.ts';
import { validateStoryChanges } from './story/core.ts';
import { normalizeName } from './story/core.ts';

const MAX_STATE_BYTES = 128 * 1024 * 1024;
const MAX_LIBRARY_CHARS = 128 * 1024 * 1024;
const LEASE_MS = 10 * 60 * 1000;
export interface Receipt { taskId: string; bookKey: string; segmentId: number; frontier: number; confirmedChars: number; understanding: string; confirmedAt?: number; episodeId?: string }
export interface ReadingTask {
  id: string; bookKey: string; segmentId: number; generation: number; expiresAt: number;
  status: 'pending' | 'committed' | 'cancelled' | 'expired'; receipt?: Receipt;
}
export interface BookEntry { book: Book; frontier: number; serial?: SerialRecord;
  /** Leading segments the human declared already read elsewhere. Read range is [skip, frontier). */
  skip?: number; skipDeclaredAt?: number }
export interface RestRecord {id:string;bookKey:string;startedAt:number;plannedUntil:number;endedAt:number|null;state:'scheduled'|'ended'|'interrupted'|'skipped';source:'session'|'model';readingMs:number}
/**
 * State-shape version.
 *
 * 4 added `plan` and `importBatches`. The bump is deliberate and fail-closed:
 * a build that only knows 1–3 refuses to open a 4 snapshot instead of silently
 * rewriting it without the new fields. That is the only protection available,
 * because an older binary cannot be taught to preserve fields it never had.
 */
export const LIBRARY_STATE_SCHEMA = 4 as const;
export interface LibraryState {
  schema: typeof LIBRARY_STATE_SCHEMA; generation: number; selected: string | null; paused: boolean;
  books: BookEntry[]; tasks: ReadingTask[]; episodes: ReadingEpisode[]; nextEpisodeSequence: number;
  reviewJobs: ReviewJob[]; reviews: BookReview[]; rests?:RestRecord[];
  /** External wishes and their mechanical acquisition/queue state. Never Persona Memory. */
  selection: SelectionState;
  /** The single cross-book reading plan. Order of `items` is the reading order. */
  plan: ReadingPlan;
  /** Batch import jobs, newest last. Importing never queues reading on its own. */
  importBatches: ImportBatch[];
}
function empty(): LibraryState { return { schema: LIBRARY_STATE_SCHEMA, generation: 0, selected: null, paused: false, books: [], tasks: [], episodes: [], nextEpisodeSequence: 1, reviewJobs: [], reviews: [],rests:[],selection:emptySelection(),plan:emptyPlan(0),importBatches:[] }; }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
const serialOf = (book: Book) => book.remote?.serial;
/**
 * A declared start is only ever a chapter boundary, never mid-chapter, and it can never
 * exceed what has been read. Kept separate so snapshots, archives and restores agree.
 */
function readStart(entry: BookEntry, total: number): number {
  const skip = entry.skip ?? 0;
  if (!integer(skip) || skip > entry.frontier || skip > total) throw new Error('Invalid declared reading start');
  if (skip > 0) {
    if (entry.skipDeclaredAt !== undefined && (!integer(entry.skipDeclaredAt) || entry.skipDeclaredAt > 8640000000000000)) throw new Error('Invalid declared reading start');
    const segments = entry.book.segments;
    if (segments[skip].chapter === segments[skip - 1].chapter) throw new Error('Declared reading start must be the first segment of a chapter');
  }
  return skip;
}
export type SerialReadiness = 'backlog' | 'waiting_content' | 'caught_up' | 'finished' | 'conflict';
function serialSummary(book: Book, frontier: number, serial = serialOf(book), skip = 0) {
  if (!serial || !book.remote) return null;
  const catalog = book.remote.catalog, cached = book.remote.cache.length, total = catalog.chapters.length;
  let confirmedChapters = 0;
  while (confirmedChapters < cached && serial.layout[confirmedChapters] <= frontier) confirmedChapters++;
  // Position counts every chapter the reading cursor has passed, including the ones
  // declared read elsewhere, so chapter progress keeps tracking the cursor.
  const positionChapters = confirmedChapters;
  // Chapters that ended at or before the declared start were read elsewhere, not here.
  let declared = 0;
  while (declared < confirmedChapters && serial.layout[declared] <= skip) declared++;
  confirmedChapters -= declared;
  let readiness: SerialReadiness;
  if (serial.lastCheck?.status === 'conflict') readiness = 'conflict';
  else if (frontier < book.segments.length) readiness = 'backlog';
  else if (cached < total) readiness = 'waiting_content';
  else if (catalog.publicationStatus === 'finished') readiness = 'finished';
  else readiness = 'caught_up';
  return { serial, catalog, cached, total, confirmedChapters, positionChapters, readiness, complete: readiness === 'finished' };
}

/** Rebuild indexes from source and verify progress against unique committed ranges before trusting a snapshot. */
export function validateState(raw: unknown, now = Date.now()): LibraryState {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid library state');
  const state = raw as LibraryState;
  const schema = (raw as { schema?: unknown }).schema;
  if (schema === 1 && ('episodes' in state || 'nextEpisodeSequence' in state)) throw new Error('Legacy schema cannot contain a new-format journal');
  // 1–3 are readable history; 4 is the current shape. Anything else is refused:
  // a newer snapshot must never be opened by a binary that cannot preserve it.
  if (schema !== 1 && schema !== 2 && schema !== 3 && schema !== 4) throw new Error('Unsupported or invalid library state');
  if ((schema === 1 || schema === 2) && ('reviews' in state || 'reviewJobs' in state)) throw new Error('Legacy schema cannot contain review records');
  if (!integer(state.generation) || typeof state.paused !== 'boolean' ||
    !Array.isArray(state.books) || state.books.length > 100 || !Array.isArray(state.tasks) || state.tasks.length > 250000) throw new Error('Unsupported or invalid library state');
  const books = new Map<string, BookEntry>();
  for (const entry of state.books) {
    if (!entry?.book || (!isPagedBook(entry.book) && typeof entry.book.text !== 'string') || !integer(entry.frontier)) throw new Error('Invalid book entry');
    const original = entry.book;
    if(isPagedBook(original)){
      const serial=entry.serial??serialOf(original);
      if(serial){const identity=stableSerialIdentity(serial.serialId,serial.editionEpoch);if(original.key!==identity.key||original.id!==identity.id||original.revision!==identity.revision)throw new Error('Serial book identity does not match its record');validateSerialRecord(serial,original.remote!.cache.length,original.segments.length);}
      if(entry.frontier>original.segments.length||books.has(original.key))throw Error('Invalid paged book progress');const pagedSkip=readStart(entry,original.segments.length);books.set(original.key,{book:original,frontier:entry.frontier,...(pagedSkip?{skip:pagedSkip,...(entry.skipDeclaredAt!==undefined?{skipDeclaredAt:entry.skipDeclaredAt}:{})}:{}),...(entry.serial?{serial:entry.serial}:{})});continue;
    }
    const rebuilt = original.remote ? buildRemoteBook(original.remote) : buildBook(original.filename, original.title, original.author, original.text);
    if (original.key !== rebuilt.key || original.id !== rebuilt.id || original.revision !== rebuilt.revision ||
      original.text !== rebuilt.text || original.sourceHash !== rebuilt.sourceHash || original.parserVersion !== rebuilt.parserVersion || original.totalChars !== rebuilt.totalChars ||
      (!Array.isArray(original.segments)||original.segments.length!==rebuilt.segments.length||original.segments.some((s,i)=>!s||Object.keys(s).length!==5||s.id!==rebuilt.segments[i].id||s.chapter!==rebuilt.segments[i].chapter||s.start!==rebuilt.segments[i].start||s.end!==rebuilt.segments[i].end||s.text!==rebuilt.segments[i].text)) || entry.frontier > rebuilt.segments.length || books.has(original.key)) throw new Error('Book content or index is inconsistent');
    books.set(original.key, { book: rebuilt, frontier: entry.frontier, ...(readStart(entry, rebuilt.segments.length) ? { skip: readStart(entry, rebuilt.segments.length), ...(entry.skipDeclaredAt !== undefined ? { skipDeclaredAt: entry.skipDeclaredAt } : {}) } : {}), ...(entry.serial ? { serial: entry.serial } : {}) });
  }
  if (state.books.reduce((n, e) => n + e.book.totalChars, 0) > MAX_LIBRARY_CHARS) throw new Error('Library exceeds size limit');
  if (state.selected !== null && (typeof state.selected !== 'string' || !books.has(state.selected))) throw new Error('Selected book is missing');
  const ids = new Set<string>();
  const committed = new Map<string, Set<number>>();
  let pending = 0; const pendingBySlot: number[] = [];
  for (const task of state.tasks) {
    const entry = books.get(task?.bookKey);
    if (!task || typeof task.id !== 'string' || !/^[a-f0-9-]{36}$/.test(task.id) || ids.has(task.id) || !entry ||
      !integer(task.segmentId) || task.segmentId >= entry.book.segments.length || !integer(task.generation) || task.generation > state.generation ||
      !integer(task.expiresAt) || !['pending', 'committed', 'cancelled', 'expired'].includes(task.status)) throw new Error('Invalid reading task');
    ids.add(task.id);
    if (task.status === 'pending') {
      pending++;
      if (task.bookKey !== state.selected || task.generation !== state.generation || state.paused) throw new Error('Inconsistent pending task');
      pendingBySlot.push(task.segmentId);
    }
    if (task.status === 'committed') {
      const r = task.receipt;
      if (!r || (r.confirmedAt !== undefined && (!integer(r.confirmedAt) || r.confirmedAt > 8640000000000000)) || r.taskId !== task.id || r.bookKey !== task.bookKey || r.segmentId !== task.segmentId ||
        r.frontier !== task.segmentId + 1 || r.confirmedChars !== entry.book.segments[task.segmentId].end ||
        typeof r.understanding !== 'string' || r.understanding.length > 2000) throw new Error('Invalid confirmation receipt');
      const ranges = committed.get(task.bookKey) ?? new Set<number>();
      if (ranges.has(task.segmentId)) throw new Error('Duplicate confirmed range');
      ranges.add(task.segmentId); committed.set(task.bookKey, ranges);
    } else if (task.receipt !== undefined) throw new Error('Uncommitted task has a receipt');
  }
  // A batch may hold 1–4 pending slots, but they must be one contiguous run that
  // starts at the frontier of the selected revision: no holes, no skipped text.
  if (pending > 4) throw new Error('Multiple pending tasks');
  pendingBySlot.sort((a, b) => a - b);
  if (pendingBySlot.some((slot, i) => slot !== pendingBySlot[0] + i)) throw new Error('Pending reading slots are not contiguous');
  if (pendingBySlot.length) {
    const selectedEntry = books.get(state.selected!)!;
    if (pendingBySlot[0] !== selectedEntry.frontier) throw new Error('Inconsistent pending task');
  }
  for (const entry of state.books) {
    const ranges = committed.get(entry.book.key) ?? new Set<number>();
    const skip = entry.skip ?? 0;
    // The confirmed range is [skip, frontier): contiguous, but it need not start at 0.
    if (ranges.size !== entry.frontier - skip || [...ranges].some((i) => i < skip || i >= entry.frontier)) throw new Error('Progress is not a continuous confirmed range');
  }
  const episodes = validateEpisodes(schema === 1 ? [] : state.episodes, books, state.tasks);
  const nextEpisodeSequence = schema === 1 ? 1 : state.nextEpisodeSequence;
  if (!Number.isSafeInteger(nextEpisodeSequence) || nextEpisodeSequence < 1 || nextEpisodeSequence <= (episodes.at(-1)?.sequence ?? 0)) throw new Error('Invalid episode sequence counter');
  const result: LibraryState = { schema: LIBRARY_STATE_SCHEMA, episodes, nextEpisodeSequence, reviewJobs: schema >= 3 ? state.reviewJobs : [], reviews: schema >= 3 ? state.reviews : [], generation: state.generation, selected: state.selected, paused: state.paused,
    selection: validateSelection((raw as { selection?: unknown }).selection),
    plan: emptyPlan(0),
    importBatches: [],
    books: [...books.values()], tasks: isHistory(state.tasks)?state.tasks:state.tasks.map((task) => ({
      id: task.id, bookKey: task.bookKey, segmentId: task.segmentId, generation: task.generation,
      expiresAt: task.expiresAt, status: task.status,
      ...(task.receipt ? { receipt: { taskId: task.receipt.taskId, bookKey: task.receipt.bookKey,
        segmentId: task.receipt.segmentId, frontier: task.receipt.frontier,
        confirmedChars: task.receipt.confirmedChars, understanding: task.receipt.understanding,
        ...(task.receipt.confirmedAt !== undefined ? { confirmedAt: task.receipt.confirmedAt } : {}),
        ...(task.receipt.episodeId ? { episodeId: task.receipt.episodeId } : {}) } } : {}),
    })) };
  const rests=state.rests??[];if(!Array.isArray(rests)||rests.length>1000)throw Error('Invalid rest history');const restIds=new Set<string>();
  for(const r of rests){if(!r||typeof r.id!=='string'||!/^[a-f0-9-]{36}$/.test(r.id)||restIds.has(r.id)||!books.has(r.bookKey)||!integer(r.startedAt)||!integer(r.plannedUntil)||r.plannedUntil<r.startedAt||(r.endedAt!==null&&(!integer(r.endedAt)||r.endedAt<r.startedAt))||!['scheduled','ended','interrupted','skipped'].includes(r.state)||!['session','model'].includes(r.source)||!Number.isFinite(r.readingMs)||r.readingMs<0)throw Error('Invalid rest record');restIds.add(r.id);}
  if(rests.filter(r=>r.state==='scheduled').length>1)throw Error('Multiple active rests');result.rests=rests;
  result.plan = validatePlan((raw as { plan?: unknown }).plan, now);
  result.importBatches = validateBatches((raw as { importBatches?: unknown }).importBatches, now);
  validateReviews(result); return result;
}

export interface LibraryOptions {
  dataDir: string;
  /** Absolute directory for full book text; empty keeps dataDir/bookfish/books. */
  textStoreDir?: string;
  /** Opt-in story memory sidecar; default off and independent of the main schema. */
  storyMemoryEnabled?: boolean;
  now?: () => number;
  /** Tests may inject a failing disk commit; live instances always use atomicWrite. */
  write?: (file: string, state: LibraryState) => void;
  beforeMetadataCommit?:()=>void;
  /** Test-only observation point after the archive write gate is closed. */
  onArchiveSnapshot?:()=>void;
}
function atomicWrite(file: string, state: LibraryState): void {
  const json = JSON.stringify(state);
  if (Buffer.byteLength(json) > MAX_STATE_BYTES) throw new Error('Library state exceeds 128 MiB; export and remove books first');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx');
    try { writeFileSync(fd, json, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export class Library {
  readonly dir: string;
  readonly file: string;
  private state: LibraryState = empty();
  private opened = false;
  private readonly bookStorage: BookStorage;
  private readonly history:HistoryStore;
  private story?:StoryStore;
  private storyError:string|null=null;
  private archiving=false;
  private readonly storyCleanupFile:string;
  private readonly restoreMarker:string;
  private historyRef?:HistoryRef;
  private planCoordinator?: PlanCoordinator;
  private characterCache=new Map<string,{characters:Array<{name:string;aliases:string[];episodeIds:string[];aliasesTruncated:boolean;episodeLinksTruncated:boolean}>;truncated:boolean}>();
  private readonly writerLock: WriterLock;
  private textStoreError: string | null = null;
  private textStoreMoved = 0;
  private readonly now: () => number;
  constructor(private readonly options: LibraryOptions) {
    this.dir = join(options.dataDir, 'bookfish'); this.file = join(this.dir, 'library.json');
    this.writerLock = new WriterLock(this.dir);
    this.storyCleanupFile = join(this.dir, 'story-cleanup.json');
    this.restoreMarker = join(this.dir, 'restore-in-progress.json');
    this.now = options.now ?? Date.now; this.bookStorage = new BookStorage(this.dir, options.textStoreDir);this.history=new HistoryStore(join(this.dir,'history.sqlite'));
    if (options.storyMemoryEnabled) this.story = new StoryStore(join(this.dir, 'story.sqlite'), { now: this.now });
  }
  private acquire(): void {
    this.writerLock.acquire();
  }
  open(): void {
    if (this.opened) return;
    mkdirSync(this.dir, { recursive: true });
    this.acquire();
    try {
      try { const moved=this.bookStorage.prepareTextStore(this.options.textStoreDir ?? '', join(this.dir,'books')); this.textStoreError=null; this.textStoreMoved=moved.moved; }
      catch (error) { this.textStoreError=String(error); this.bookStorage.fallbackToDefault(join(this.dir,'books')); }
      this.history.open();
      if (this.story) {
        try { this.story.open(); this.storyError = null; }
        catch (error) { this.storyError = String(error); }
      }
      if (existsSync(this.file)) {
        if (statSync(this.file).size > MAX_STATE_BYTES) throw new Error('Library state is too large');
        const raw=JSON.parse(readFileSync(this.file, 'utf8'));
        if(![5,6,7,8].includes(raw.schema)&&!existsSync(this.file+'.before-paged'))copyFileSync(this.file,this.file+'.before-paged');
        if(![6,7,8].includes(raw.schema)&&!existsSync(this.file+'.before-history')){copyFileSync(this.file,this.file+'.before-history');this.bookStorage.protectRollback(raw);}
        const hydrated=this.bookStorage.hydrate(raw) as LibraryState;if([6,7,8].includes(raw.schema)){this.historyRef=raw.$history;this.state=validateState(this.history.hydrate(hydrated,raw.$history));}else this.state=validateState(hydrated);
        if(!raw.books.some((e:{book:{$bookBlob?:unknown}})=>e.book?.$bookBlob)&&!existsSync(this.file+'.before-split-v3'))copyFileSync(this.file,this.file+'.before-split-v3');
      }
      this.recoverTemporary();
      this.opened = true;
      this.change((draft) => this.syncPlan(draft));
      if (existsSync(this.restoreMarker)) {
        this.bookStorage.collect(this.state);
        if (this.story) {
          this.cleanupOrphanStoryRecords();
          if (existsSync(this.restoreMarker)) unlinkSync(this.restoreMarker);
        }
      }
      this.retryStoryCleanups();
    } catch (error) {
      try { this.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], `Bookfish 初始化失败：${String(error)}；资源清理失败：${String(cleanup)}`); }
      throw error;
    }
  }
  private recoverTemporary(){
    // Writer lock is held and the committed snapshot has passed validation.
    const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
    const patterns=[{dir:this.dir,re:new RegExp('^(?:library\\.json\\.'+uuid+'\\.tmp|'+uuid+'\\.history-(?:backup|restore)\\.sqlite)$')},{dir:this.bookStorage.dir,re:new RegExp('^(?:'+uuid+'(?:\\.canonical)?\\.tmp|[a-f0-9]{64}\\.json\\.gz\\.'+uuid+'\\.tmp)$')}];
    for(const {dir,re}of patterns)if(existsSync(dir))for(const name of readdirSync(dir)){if(re.test(name)){const file=join(dir,name),st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw Error('Unexpected temporary path');unlinkSync(file);}}
  }
  close(): void {
    this.opened = false;
    const errors: unknown[] = [];
    for (const close of [() => this.bookStorage.clearCache(), () => this.history.close(), () => this.story?.close()]) {
      try { close(); } catch (error) { errors.push(error); }
    }
    // A failed business close may still own a connection: keep the writer fence for retry.
    if (errors.length) throw new AggregateError(errors, 'Bookfish 书库资源关闭失败，写锁仍保留；请重试关闭或退出当前实例');
    this.state = empty(); this.storyError=null;this.historyRef=undefined;this.goalCache=undefined;this.characterCache.clear();
    this.writerLock.release();
  }
  storageStats(){return {...this.bookStorage.cache.stats(),history:this.history.stats(),textStore:this.textStoreStatus()};}
  textStoreStatus(){return {dir:this.bookStorage.dir,defaultDir:join(this.dir,'books'),configured:this.options.textStoreDir??'',error:this.textStoreError,moved:this.textStoreMoved};}
  private ensureOpen(): void { if (!this.opened) throw new Error('Bookfish library is not mounted'); }
  private change<T>(action: (draft: LibraryState) => T): T {
    this.ensureOpen();
    if (this.archiving) throw new Error('Library is being archived; no writes are allowed');
    const draft = { ...structuredClone({ ...this.state, books: [],tasks:[],episodes:[] }), tasks:historyFork(this.state.tasks),episodes:historyFork(this.state.episodes),books: this.state.books.map(e=>({ book:e.book, frontier:e.frontier, ...(e.skip?{skip:e.skip,...(e.skipDeclaredAt!==undefined?{skipDeclaredAt:e.skipDeclaredAt}:{})}:{}), ...(e.serial?{serial:e.serial}:{}) })) };
    const result = action(draft);
    if(this.options.write)this.options.write(this.file,draft);else {const ref=this.history.prepare(draft,this.historyRef);this.options.beforeMetadataCommit?.();atomicWrite(this.file,{...this.bookStorage.prepare(draft) as LibraryState,schema:8,tasks:[],episodes:[],$history:ref} as unknown as LibraryState);this.historyRef=ref;this.state=this.history.bind(draft,ref);this.history.committed(ref);}
    if(this.options.write)this.state = draft;
    if(!this.options.write)this.bookStorage.collect(draft);
    this.goalCache=undefined;return structuredClone(plainHistory(result));
  }
  private invalidate(draft: LibraryState): void {
    draft.generation++;
    for (const task of historySelect(draft.tasks,{status:'pending'})) if (task.status === 'pending') task.status = 'cancelled';
    for (const job of draft.reviewJobs) if (job.status === 'pending') { job.status = 'cancelled'; job.error = 'Library remounted, paused or revision changed; retry explicitly with a new requestId'; }
  }
  /**
   * One-time migration of the old pet queue into the single plan, then a
   * reconciliation against the books that actually exist. Runs inside the same
   * atomic snapshot as the pending-task invalidation, so a crash cannot leave a
   * half-migrated plan and old progress behind.
   */
  private syncPlan(draft: LibraryState): void {
    const now = this.now();
    if (draft.plan.items.length === 0 && draft.plan.archive.length === 0 && draft.selection.queue.length) {
      const books = new Map(draft.books.map((entry) => [entry.book.key, { title: entry.book.title, author: entry.book.author }]));
      draft.plan = migrateLegacyQueue(draft.selection.queue, books, now).plan;
      draft.selection.queue = [];
    }
    reconcilePlan(draft.plan, new Set(draft.books.map((entry) => entry.book.key)), now);
    for (const entry of draft.books) {
      const item = findItem(draft.plan, entry.book.key);
      if (item && this.view(entry).complete) archiveItem(draft.plan, item.id, 'completed', now, 'completed_before_plan_advance');
    }
    this.invalidate(draft);
  }
  /** A restored subscription keeps its intent only as a hint; it must never resume network access without the user. */
  private pauseSerialAfterRestore(draft: LibraryState): void {
    for (const entry of draft.books) {
      const serial = entry.serial ?? serialOf(entry.book);
      if (!serial) continue;
      const at = new Date(this.now()).toISOString();
      const next: SerialRecord = { ...serial, subscriptionRevision: serial.subscriptionRevision + 1,
        subscription: { ...serial.subscription, enabled: false, nextCheckAt: null, backoffUntil: null },
        lastCheck: { at, status: 'no_change', message: '备份已还原；确认来源可用后手动恢复追更。' } };
      entry.serial = next;
    }
  }
  private current(state = this.state): BookEntry {
    const entry = state.books.find((e) => e.book.key === state.selected);
    if (!entry) throw new Error('Select a book first');
    return entry;
  }
  reader(input:unknown){
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid reader request');
    const {bookKey,segment=0,chapterOffset=0}=input as Record<string,unknown>;
    const entry=this.state.books.find(e=>e.book.key===bookKey);if(!entry)throw Error('Book not found');
    if(!Number.isSafeInteger(segment)||Number(segment)<0||Number(segment)>=entry.book.segments.length||!Number.isSafeInteger(chapterOffset)||Number(chapterOffset)<0)throw Error('Invalid reader position');
    const b=entry.book,start=Number(segment),chapters=readerChapters(b),index=Number(chapterOffset);let end=start;
    const chunks:Array<{id:number;text:string}>=[];
    while(end<b.segments.length&&end<start+8&&b.segments[end].chapter===b.segments[start].chapter){chunks.push({id:end,text:b.segments[end].text});end++;}
    return {bookKey:b.key,title:b.title,chapter:b.segments[start].chapter,segment:start,segments:chunks,totalSegments:b.segments.length,previous:start?Math.max(0,start-8):null,next:end<b.segments.length?end:null,chapters:chapters.slice(index,index+100),chapterOffset:index,nextChapterOffset:index+100<chapters.length?index+100:null,cachedOnly:!!b.remote};
  }
  /**
   * Human-declared prior reading: the reader already finished the leading chapters elsewhere.
   * Deliberately NOT a model tool — only the WebUI panel may call it, so book text can never
   * talk the pet into skipping ahead. Records no receipt and never marks skipped text read.
   */
  setReadingStart(key: unknown, segment: unknown) {
    this.ensureOpen();
    const entry = this.state.books.find((e) => e.book.key === key);
    if (!entry) throw new Error('Book is not in the library');
    if (!integer(segment) || segment >= entry.book.segments.length) throw new Error('Start segment is out of range');
    const current = entry.skip ?? 0;
    if (entry.frontier !== current) throw new Error('Reading has already started in BookFish; the start point is locked for this revision');
    if (segment > 0 && entry.book.segments[segment].chapter === entry.book.segments[segment - 1].chapter) throw new Error('Start must be the first segment of a chapter');
    return this.change((draft) => {
      const target = draft.books.find((e) => e.book.key === key)!;
      this.invalidate(draft);
      target.frontier = Number(segment);
      if (segment) { target.skip = Number(segment); target.skipDeclaredAt = this.now(); }
      else { delete target.skip; delete target.skipDeclaredAt; }
      return this.view(target);
    });
  }
  /** Chapter starts for the "start from chapter" control; positions are absolute segment ids. */
  chapters(key: unknown) {
    this.ensureOpen();
    const entry = this.state.books.find((e) => e.book.key === key);
    if (!entry) throw new Error('Book is not in the library');
    const all = readerChapters(entry.book);
    const items = all.slice(0, 5000).map((chapter) => ({ title: chapter.title, segment: chapter.segment }));
    return { bookKey: entry.book.key, total: all.length, truncated: all.length > items.length, items };
  }
  private view(entry: BookEntry) {
    const b = entry.book;
    const skip = entry.skip ?? 0;
    const serial = serialSummary(b, entry.frontier, entry.serial, skip);
    const positionChars = entry.frontier ? b.segments[entry.frontier - 1].end : 0;
    const confirmedChars = entry.frontier > skip ? b.segments[entry.frontier - 1].end - b.segments[skip].start : 0;
    const loaded = b.remote?.cache.length ?? 0;
    let completedChapters = serial?.confirmedChapters ?? 0;
    const layout=remoteLayout(b);if(layout&&!serial)completedChapters=layout.ends.filter(end=>end<=entry.frontier&&end>skip).length;
    if (b.remote&&!layout&&!serial) {
      let segmentCount = 0;
      for (const chapter of b.remote.cache) {
        segmentCount += Math.ceil(Array.from(`# ${b.remote.catalog.chapters[chapter.index].title}\n${chapter.text}\n\n`).length / 1200);
        if (entry.frontier >= segmentCount && segmentCount > skip) completedChapters++;
      }
    }
    const chapterIndex = Math.max(0, entry.frontier > skip ? entry.frontier-1 : skip); let lo=chapterIndex, hi=chapterIndex;
    const span=chapterSpan(b,chapterIndex);if(span){lo=span.first;hi=span.last;}
    while(!span && lo>0 && b.segments[lo-1].chapter===b.segments[chapterIndex].chapter)lo--;
    while(!span && hi+1<b.segments.length && b.segments[hi+1].chapter===b.segments[chapterIndex].chapter)hi++;
    const chapterProgress=entry.frontier>skip && b.segments.length ? (positionChars-b.segments[lo].start)/(b.segments[hi].end-b.segments[lo].start) : 0;
    const totalChapters=serial?.total ?? (b.remote?b.remote.catalog.chapters.length:0);
    return { chapterProgress, key: b.key, id: b.id, revision: b.revision, title: b.title, author: b.author,
      identifiedChapters:serial?serial.total:b.remote?b.remote.catalog.chapters.length:chapterEndIds(b).size,chapterGoalSupported:!!b.remote||chapterEndIds(b).size>0,
      totalChars: b.totalChars, totalSegments: b.segments.length, confirmedSegments: entry.frontier - skip,
      confirmedChars, priorReadingSegments: skip, positionSegments: entry.frontier, positionChars,
      progress: serial ? (serial.total ? serial.positionChapters / serial.total : 0) : b.remote ? completedChapters / b.remote.catalog.chapters.length : positionChars / b.totalChars,
      progressUnit: b.remote ? 'chapters' as const : 'characters' as const,
      chapter: entry.frontier > skip ? b.segments[entry.frontier - 1].chapter : skip ? b.segments[skip].chapter : '尚未开始',
      complete: serial ? serial.complete : entry.frontier === b.segments.length && (!b.remote || (loaded === b.remote.catalog.chapters.length && b.remote.catalog.publicationStatus === 'finished')),
      readiness: serial?.readiness ?? (entry.frontier === b.segments.length && b.remote ? 'caught_up' : 'backlog'),
      serial: serial ? { serialId: serial.serial.serialId, editionEpoch: serial.serial.editionEpoch, contentVersion: serial.serial.contentVersion,
        subscriptionRevision: serial.serial.subscriptionRevision, authorization: serial.serial.authorization, authorizationNote: serial.serial.authorizationNote,
        capabilities: { ...serial.serial.capabilities }, publicationEvidence: { ...serial.serial.publicationEvidence },
        subscription: { ...serial.serial.subscription }, lastCheck: serial.serial.lastCheck ? { ...serial.serial.lastCheck } : null,
        discoveredChapters: serial.total, cachedChapters: serial.cached, confirmedChapters: serial.confirmedChapters,
        recentReceipts: serial.serial.receipts.slice(-3).map(r => ({ jobId: r.jobId, at: r.at, status: r.status, addedCount: r.addedCount, error: r.error })) } : null,
      source: b.remote ? { adapter: b.remote.catalog.adapter, bookUrl: b.remote.catalog.bookUrl,
        catalogHash: b.remote.catalog.hash, catalogFetchedAt: b.remote.catalog.fetchedAt,
        totalChapters: b.remote.catalog.chapters.length, cachedChapters: loaded, confirmedChapters: completedChapters,
        publicationStatus: b.remote.catalog.publicationStatus,
        status: serial?.serial.lastCheck?.status ?? b.remote.lastError?.code ?? (loaded === b.remote.catalog.chapters.length ? 'cached' : 'partial'),
        error: b.remote.lastError ?? null, lastFetchedAt: layout?layout.lastFetchedAt:b.remote.cache[loaded - 1]?.fetchedAt ?? null } : null };
  }
  list() { this.ensureOpen(); return this.state.books.map((entry) => this.view(entry)); }
  status() {
    const entry = this.state.books.find((e) => e.book.key === this.state.selected);
    const task = this.opened ? historySelect(this.state.tasks,{status:'pending'}).find(t=>t.expiresAt>this.now()) : undefined;
    const offered=entry?historyPage(this.state.tasks,{bookKey:entry.book.key},1):[];
    return { mounted: this.opened, paused: this.state.paused, current: entry ? this.view(entry) : null,
      providedChars: offered.length?entry!.book.segments[offered[0].segmentId].end:0,
      pending: task ? { taskId: task.id, bookKey: task.bookKey, segmentId: task.segmentId, expiresAt: task.expiresAt } : null,
      textStore: this.textStoreStatus(), story: this.storyStatus() };
  }
  storyStatus(): { enabled: boolean; error: string | null; path?: string; schemaVersion?: number; records?: number; batches?: number; pendingCleanups?: number; packs?: number; changeSeq?: number; readOnly?: boolean } {
    if (!this.story) {
      const pending = this.pendingCleanupCount();
      return pending ? { enabled: false, error: this.storyError, pendingCleanups: pending } : { enabled: false, error: this.storyError };
    }
    try { return { enabled: true, error: this.storyError, ...this.story.status(), pendingCleanups: this.pendingCleanupCount() }; }
    catch (error) { return { enabled: true, error: String(error), pendingCleanups: this.pendingCleanupCount() }; }
  }
  private pendingCleanupFileCount(): number {
    try {
      if (!existsSync(this.storyCleanupFile)) return 0;
      const value = JSON.parse(readFileSync(this.storyCleanupFile, 'utf8'));
      if (!Array.isArray(value)) throw new Error('Story cleanup tombstone is not an array');
      return value.length;
    } catch (error) { this.storyError = String(error); return 1; }
  }
  private readCleanupTombstones(strict = true): Array<Record<string, unknown>> {
    if (!existsSync(this.storyCleanupFile)) return [];
    try {
      const value = JSON.parse(readFileSync(this.storyCleanupFile, 'utf8'));
      if (!Array.isArray(value)) throw new Error('Story cleanup tombstone is not an array');
      return value;
    } catch (error) {
      this.storyError = String(error);
      if (strict) throw new Error(`Story cleanup tombstone is corrupt: ${String(error)}`);
      return [];
    }
  }
  private pendingCleanupCount(): number {
    let storeCount = 0;
    try { storeCount = this.story?.pendingCleanups().length ?? 0; } catch {}
    return storeCount + this.pendingCleanupFileCount();
  }
  private cleanupStoryBook(bookKey: string) {
    if (this.story) return this.story.deleteBook(bookKey);
    const file = join(this.dir, 'story.sqlite');
    if (!existsSync(file)) return { records: 0, batches: 0 };
    const store = new StoryStore(file, { now: this.now });
    try { store.open(); return store.deleteBook(bookKey); } finally { store.close(); }
  }
  private writeCleanupTombstone(bookKey: string, reason: string) {
    const items = this.readCleanupTombstones(true);
    const existing = items.find(item => item.bookKey === bookKey);
    if (existing) { existing.attempts = Number(existing.attempts ?? 0) + 1; existing.lastError = reason.slice(0, 500); existing.updatedAt = this.now(); }
    else items.push({ bookKey, attempts: 1, lastError: reason.slice(0, 500), createdAt: this.now(), updatedAt: this.now() });
    const trimmed = items.slice(-100);
    const tmp = this.storyCleanupFile + '.' + randomUUID() + '.tmp';
    const fd = openSync(tmp, 'wx');
    try { writeFileSync(fd, JSON.stringify(trimmed)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.storyCleanupFile);
    try { const dirFd = openSync(this.dir, 'r'); try { fsyncSync(dirFd); } finally { closeSync(dirFd); } } catch {}
  }
  private cleanupOrphanStoryRecords() {
    if (!this.story || this.storyError) return;
    try {
      const known = new Set(this.state.books.map(entry => entry.book.key));
      for (const bookKey of this.story.listBookKeys()) {
        if (known.has(bookKey)) continue;
        try { this.story.recordCleanup(bookKey, 'orphan story record from interrupted restore or removed book'); }
        catch (error) { this.writeCleanupTombstone(bookKey, String(error)); }
      }
    } catch (error) { this.storyError = String(error); }
  }
  retryStoryCleanups() {    let cleaned = 0, failed = 0;
    if (this.story && !this.storyError) {
      try { const result = this.story.retryCleanups(); cleaned += result.cleaned; failed += result.failed; }
      catch (error) { this.storyError = String(error); failed++; }
    }
    let items: Array<Record<string, unknown>> = [];
    try { items = this.readCleanupTombstones(true); }
    catch (error) { return { cleaned, failed: failed + 1, pending: this.pendingCleanupCount(), error: String(error) }; }
    if (!items.length) return { cleaned, failed, pending: this.pendingCleanupCount() };
    const remaining: Array<Record<string, unknown>> = [];
    for (const item of items) {
      const bookKey = String(item.bookKey ?? '');
      if (!bookKey) continue;
      try { this.cleanupStoryBook(bookKey); cleaned++; }
      catch (error) { failed++; remaining.push({ ...item, attempts: Number(item.attempts ?? 0) + 1, lastError: String(error).slice(0, 500), updatedAt: this.now() }); }
    }
    const tmp = this.storyCleanupFile + '.' + randomUUID() + '.tmp';
    writeFileSync(tmp, JSON.stringify(remaining));
    renameSync(tmp, this.storyCleanupFile);
    return { cleaned, failed, pending: this.pendingCleanupCount() };
  }
  /** Backend capture entry point; a future tool layer must validate text with the core first. */
  captureStory(input: Record<string, unknown>) {    this.ensureOpen();
    if (this.archiving) throw new Error('Library is being archived; no story writes are allowed');
    if (!this.story) throw new Error('Story memory is disabled');
    if (this.storyError) throw new Error(`Story memory unavailable: ${this.storyError}`);
    const bookKey = requiredText(input.bookKey, 'bookKey', 150);
    const entry = this.state.books.find((e) => e.book.key === bookKey);
    if (!entry) throw new Error('Book revision is not in the library');
    const requestId = requiredText(input.requestId, 'requestId', 80);
    if (!Array.isArray(input.changes)) throw new Error('changes must be an array');
    // Chapters declared read elsewhere are not text this reader ever saw: no story facts from them.
    const skip = entry.skip ?? 0;
    if (skip) for (const change of input.changes as Array<Record<string, unknown>>) {
      const evidence = Array.isArray(change?.evidence) ? change.evidence as Array<Record<string, unknown>> : [];
      for (const item of evidence) if (Number.isSafeInteger(item?.segmentId) && Number(item.segmentId) < skip) throw new Error('Story evidence must come from text read in BookFish; earlier chapters were declared read elsewhere');
    }
    const changes = validateStoryChanges(input.changes, entry.book, { frontier: entry.frontier }) as StoryChange[];
    return this.story.capture({ bookKey, bookRevision: entry.book.revision,
      contentVersion: entry.serial?.contentVersion ?? null, frontier: entry.frontier,
      requestId, changes });
  }
  putStoryPack(input: Record<string, unknown>) {
    this.ensureOpen();
    if (this.archiving) throw new Error('Library is being archived; no story writes are allowed');
    if (!this.story) throw new Error('Story memory is disabled');
    if (this.storyError) throw new Error(`Story memory unavailable: ${this.storyError}`);
    const bookKey = requiredText(input.bookKey, 'bookKey', 150);
    const entry = this.state.books.find((e) => e.book.key === bookKey);
    if (!entry) throw new Error('Book revision is not in the library');
    const packSkip = entry.skip ?? 0;
    if (packSkip) {
      const ranges = Array.isArray((input as { coveredRanges?: unknown }).coveredRanges) ? (input as { coveredRanges: Array<Record<string, unknown>> }).coveredRanges : [];
      for (const range of ranges) if (Number.isSafeInteger(range?.from) && Number(range.from) < packSkip) throw new Error('Story packs may only cover text read in BookFish; earlier chapters were declared read elsewhere');
    }
    return this.story.putPack({
      ...(input as unknown as StoryPackInput),
      bookKey, bookRevision: entry.book.revision,
      contentVersion: entry.serial?.contentVersion ?? null,
      frontier: entry.frontier,
    });
  }
  listStoryPacks(bookKey: string, contentVersion?: number | null) {
    this.ensureOpen();
    if (!this.story) throw new Error('Story memory is disabled');
    return this.story.listPacks(bookKey, contentVersion);
  }
  invalidateStoryPacks(bookKey: string, contentVersion?: number | null) {
    this.ensureOpen();
    if (this.archiving) throw new Error('Library is being archived; no story writes are allowed');
    if (!this.story) throw new Error('Story memory is disabled');
    return this.story.invalidatePacks(bookKey, contentVersion);
  }
  validateStoryPacks(bookKey: string, contentVersion?: number | null) {
    this.ensureOpen();
    if (!this.story) throw new Error('Story memory is disabled');
    return this.story.validatePackTree(bookKey, contentVersion);
  }
  publishStoryPack(id: string, contentVersion?: number | null) {
    this.ensureOpen();
    if (this.archiving) throw new Error('Library is being archived; no story writes are allowed');
    if (!this.story) throw new Error('Story memory is disabled');
    return this.story.publishPack(id, contentVersion);
  }
  storyOverview(bookKey: string, atFrontier?: number, limit = 20, cursor?: string) {
    this.ensureOpen();
    if (!this.story) throw new Error('Story memory is disabled');
    const entry = this.state.books.find(e => e.book.key === bookKey);
    if (!entry) throw new Error('Book revision is not in the library');
    const frontier = atFrontier === undefined ? entry.frontier : Math.max(0, Math.min(entry.frontier, atFrontier));
    const version = entry.serial?.contentVersion ?? null;
    const changeSeq = this.story.changeSeq();
    const pageSize = Math.max(1, Math.min(20, Math.trunc(limit)));
    let offset = 0;
    if (cursor !== undefined) {
      let payload: any;
      try { payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
      catch { throw new Error('Invalid story overview cursor'); }
      if (payload.b !== bookKey || payload.v !== version || payload.f !== frontier || payload.s !== changeSeq || payload.l !== pageSize) {
        throw new Error('Story overview snapshot changed; restart from the first page');
      }
      offset = Math.max(0, Number(payload.o) || 0);
    }
    const all = this.story.listPacks(bookKey, version);
    const visible = all.filter(pack => pack.frontier <= frontier);
    const packs = visible.slice(offset, offset + pageSize).map(pack => ({ id: pack.id, level: pack.level, label: pack.label, summary: pack.summary, frontier: pack.frontier, coveredRanges: pack.coveredRanges, inputFingerprint: pack.inputFingerprint }));
    const next = offset + pageSize < visible.length
      ? Buffer.from(JSON.stringify({ b: bookKey, v: version, f: frontier, s: changeSeq, l: pageSize, o: offset + pageSize })).toString('base64url')
      : null;
    return { bookKey, frontier, total: visible.length, returned: packs.length, omitted: visible.length - packs.length, nextCursor: next, truncated: next !== null, hasFuturePacks: all.length > visible.length, packs };
  }
  createStoryEntity(input: Record<string, unknown>) {
    this.ensureOpen();
    if (this.archiving) throw new Error('Library is being archived; no story writes are allowed');
    if (!this.story) throw new Error('Story memory is disabled');
    const bookKey = requiredText(input.bookKey, 'bookKey', 150);
    const entry = this.state.books.find(e => e.book.key === bookKey);
    if (!entry) throw new Error('Book revision is not in the library');
    return this.story.createEntity({ ...(input as any), bookKey, contentVersion: entry.serial?.contentVersion ?? null, firstRevealedAt: entry.frontier });
  }
  bindStoryEntity(entityId: string, aliases: string[] = [], revealedAt?: number) {
    this.ensureOpen();
    if (this.archiving) throw new Error('Library is being archived; no story writes are allowed');
    if (!this.story) throw new Error('Story memory is disabled');
    return this.story.bindEntity(entityId, aliases, revealedAt);
  }
  storyEntityCandidates(bookKey: string, name: string, atFrontier?: number) {
    this.ensureOpen();
    if (!this.story) throw new Error('Story memory is disabled');
    const entry = this.state.books.find(e => e.book.key === bookKey);
    if (!entry) throw new Error('Book revision is not in the library');
    const frontier = atFrontier === undefined ? entry.frontier : Math.max(0, Math.min(entry.frontier, atFrontier));
    const bound = this.story.resolveEntity(bookKey, name, frontier, entry.serial?.contentVersion ?? null);
    if (bound.status !== 'none') return bound;
    const wanted = normalizeName(name);
    const records = this.story.list(bookKey, entry.serial?.contentVersion ?? null);
    const candidates = [];
    for (const record of records) {
      if (record.revealedAt > frontier) continue;
      const payload = record.payload as Record<string, any>;
      const values = [...(Array.isArray(payload.names) ? payload.names : []), payload.fromName, payload.toName].filter((value): value is string => typeof value === 'string');
      if (!values.some(value => normalizeName(value) === wanted)) continue;
      candidates.push({ recordId: record.id, kind: record.kind, summary: payload.summary, names: values, fromEntityId: payload.fromEntityId ?? null, toEntityId: payload.toEntityId ?? null, status: payload.entityBinding ?? 'unresolved' });
    }
    return { status: candidates.length === 0 ? 'none' : candidates.length === 1 ? 'resolved' : 'ambiguous', candidates };
  }
  storyEvidence(bookKey: string, eventIds: string[], atFrontier?: number) {
    this.ensureOpen();
    if (!this.story) throw new Error('Story memory is disabled');
    const entry = this.state.books.find(e => e.book.key === bookKey);
    if (!entry) throw new Error('Book revision is not in the library');
    const frontier = atFrontier === undefined ? entry.frontier : Math.max(0, Math.min(entry.frontier, atFrontier));
    const version = entry.serial?.contentVersion ?? null;
    const selected = eventIds.slice(0, 8);
    const omittedEventIds = eventIds.slice(8);
    return { bookKey, frontier, requested: eventIds.length, returned: selected.length, truncated: omittedEventIds.length > 0, omittedEventIds, events: selected.map(id => {
      const record = this.story!.get(id);
      if (record.bookKey !== bookKey || record.contentVersion !== version) throw new Error('Story record belongs to another version');
      if (record.revealedAt > frontier) return { id, omitted: true, reason: 'unread-at-frontier' };
      return { id, summary: record.payload.summary, kind: record.kind, status: record.status, sourceKind: record.sourceKind, revealedAt: record.revealedAt, evidence: record.evidence };
    }) };
  }
  import(input: unknown) { return this.addBook(decodeFile(input)); }
  importBytes(metadata: {filename:unknown;title:unknown;author?:unknown}, bytes:Uint8Array) { return this.addBook(buildBook(metadata.filename,metadata.title,metadata.author,bytes)); }
  importFile(metadata:{filename:unknown;title:unknown;author?:unknown},file:string){
    this.ensureOpen();try{return this.addBook(this.bookStorage.importFile(file,metadata));}finally{this.bookStorage.collect(this.state);}
  }
  adoptValidatedImport(file:string,id:string,receipt:{size:number;mtimeMs:number}){
    this.ensureOpen();try{return this.addBook(this.bookStorage.adoptValidatedImport(file,id,receipt));}finally{this.bookStorage.collect(this.state);}
  }
  /**
   * Controlled loose import for the TXT acquisition flow. Ordinary `importFile`
   * stays strict; this path decodes leniently, records what it repaired and
   * refuses only files that cannot form readable prose. A rejected file leaves
   * its original bytes in the acquisition staging area for a later retry.
   */
  importFileBestEffort(
    metadata:{filename:unknown;title:unknown;author?:unknown},
    file:string,
    options?:{wanted?:{title?:string;author?:string};declared?:{title?:string;author?:string};decoded?:BestEffortDecoded},
  ){
    this.ensureOpen();
    try{
      const {book,decoded}=this.bookStorage.importFileBestEffort(file,metadata,options?.decoded);
      const assessment=assessText({
        text:decoded.text,
        metrics:decoded.metrics,
        warnings:decoded.warnings,
        encoding:decoded.encoding,
        replacements:decoded.replacements,
        truncatedTail:decoded.truncatedTail,
        repairs:decoded.repairs,
        filename:book.filename,
        ...(options?.wanted?{wanted:options.wanted}:{}),
        ...(options?.declared?{declared:options.declared}:{}),
      });
      if(assessment.verdict==='reject'&&assessment.reject)throw new BestEffortRejected(assessment.reject.code,assessment.reject.message);
      const added=this.addBook(book);
      return {
        imported:true as const,
        duplicate:added.duplicate,
        book:added.book,
        quality:assessment.report,
        readableChars:assessment.report.readableChars,
        identity:assessment.identity,
        repairs:assessment.report.repairs.map(issue=>issue.code),
      };
    }finally{
      // Unreferenced blobs from a rejected or duplicate import are collected here.
      this.bookStorage.collect(this.state);
    }
  }
  private addBook(book:Book) {
    return this.change((draft) => {
      const old = draft.books.find((e) => e.book.key === book.key);
      if (old) return { duplicate: true, book: this.view(old) };
      if (draft.books.length >= 100 || draft.books.reduce((n, e) => n + e.book.totalChars, 0) + book.totalChars > MAX_LIBRARY_CHARS) throw new Error('Library is full; export and remove books first');
      const entry = { book, frontier: 0 };
      draft.books.push(entry);
      return { duplicate: false, book: this.view(entry) };
    });
  }
  generation(): number { this.ensureOpen(); return this.state.generation; }
  /**
   * Selection state plus a *derived* queue projection of the single plan.
   *
   * The plan is the only queue. `queue` stays in this view so older UI code and
   * tests can keep reading it, but it is never persisted back: `updateSelection`
   * writes only intents/rounds/failures, and the plan is written by `addToPlan`.
   */
  selection(): SelectionState {
    this.ensureOpen();
    const state = structuredClone(this.state.selection);
    // Only genuinely readable entries are projected. A finished revision is
    // already recorded in the plan archive, so listing it as `queued` would let
    // the pet offer text for a book it has completed.
    const readable = new Map(this.state.books.map((entry) => [entry.book.key, this.view(entry)]));
    state.queue = this.state.plan.items
      .filter((item) => readable.has(item.bookKey) && !readable.get(item.bookKey)!.complete)
      .map((item) => ({
        id: item.id, intentId: item.intentId ?? '', bookKey: item.bookKey, title: item.title,
        source: item.source === 'persona' ? 'pet' as const : 'user' as const,
        status: item.bookKey === this.state.selected ? 'active' as const : 'queued' as const,
        addedAt: item.addedAt, updatedAt: this.state.plan.updatedAt,
        ...(item.notBefore !== undefined ? { notBefore: item.notBefore } : {}),
      }));
    return state;
  }
  /** The single writable path for autonomous-selection records; it participates in the same atomic snapshot. */
  updateSelection<T>(action: (draft: SelectionState) => T): T {
    return this.change((draft) => { const result = action(draft.selection); draft.selection.generation++; return result; });
  }
  // ------------------------------------------------------------ batch import
  /** Batches live in the same atomic snapshot as the shelf; there is no second store. */
  importBatches(): ImportBatch[] { this.ensureOpen(); return structuredClone(this.state.importBatches); }
  createImportBatch(batch: ImportBatch): ImportBatch {
    this.ensureOpen();
    return this.change((draft) => {
      if (draft.importBatches.some((row) => row.id === batch.id)) throw new Error('Import batch already exists');
      draft.importBatches = trimBatches([...draft.importBatches, structuredClone(batch)]);
      return structuredClone(draft.importBatches.find((row) => row.id === batch.id)!);
    });
  }
  addImportBatchItems(batchId: string, inputs: readonly BatchItemInput[], extra: { tooLarge?: readonly string[]; overBudget?: readonly string[] } = {}): BatchAddResult {
    this.ensureOpen();
    return this.change((draft) => {
      const batch = draft.importBatches.find((row) => row.id === batchId);
      if (!batch) throw new Error('Import batch not found');
      if (batch.status !== 'preview') throw new Error('Import batch already started');
      const result = addBatchItems(batch, inputs, this.now());
      // Everything this request refused is recorded in the same atomic write, so
      // a partial import can never look complete after the batch is committed.
      recordRejected(batch, {
        unsupported: result.unsupported,
        duplicate: result.duplicates,
        tooLarge: [...extra.tooLarge ?? [], ...result.tooLarge],
        overBudget: [...extra.overBudget ?? [], ...result.overBudget],
        overflow: result.overflow,
        overflowNames: result.overflowNames,
      });
      return result;
    });
  }
  /**
   * Single-item progress writes are item-granular on purpose: the snapshot holds
   * book metadata and blob references only, so a write is a few kilobytes.
   */
  updateImportBatch<T>(batchId: string, action: (draft: ImportBatch) => T): T {
    this.ensureOpen();
    return this.change((draft) => {
      const batch = draft.importBatches.find((row) => row.id === batchId);
      if (!batch) throw new Error('Import batch not found');
      const result = action(batch);
      batch.updatedAt = this.now();
      return result;
    });
  }
  /** Drop a finished batch record; imported books and their progress are untouched. */
  forgetImportBatch(batchId: string): ImportBatch[] {
    this.ensureOpen();
    return this.change((draft) => {
      const batch = draft.importBatches.find((row) => row.id === batchId);
      if (!batch) throw new Error('Import batch not found');
      if (batch.items.some((item) => ['pending', 'importing', 'processing', 'validating'].includes(item.status))) throw new Error('Import batch is still running');
      draft.importBatches = draft.importBatches.filter((row) => row.id !== batchId);
      return structuredClone(draft.importBatches);
    });
  }
  // ------------------------------------------------------------ reading plan
  /** Raw plan copy; mutations only through the methods below so every write is one atomic snapshot. */
  plan(): ReadingPlan { this.ensureOpen(); return structuredClone(this.state.plan); }  /**
   * Cross-book hand-off entry point. The scheduler calls it only at a real idle
   * opportunity; the coordinator itself re-checks completion, review and gates.
   */
  advancePlan(scheduler: PlanSchedulerView): PlanAdvanceResult {
    this.ensureOpen();
    this.planCoordinator ??= new PlanCoordinator(this, this.now);
    return this.planCoordinator.attempt(scheduler);
  }
  /**
   * Select the next planned revision and stamp its start in one atomic snapshot.
   * Used only by the plan hand-off, after the previous book is genuinely complete.
   */
  selectPlanned(bookKey: string) {
    this.ensureOpen();
    return this.change((draft) => {
      const entry = draft.books.find((row) => row.book.key === bookKey);
      if (!entry) throw new Error('Book revision is not in the library');
      if (draft.selected !== bookKey) { this.invalidate(draft); draft.selected = bookKey; }
      const item = findItem(draft.plan, bookKey);
      if (item && item.startedAt === undefined) { item.startedAt = this.now(); draft.plan.revision += 1; draft.plan.updatedAt = this.now(); }
      return this.view(entry);
    });
  }
  updatePlan<T>(action: (draft: ReadingPlan) => T): T {
    this.ensureOpen();
    return this.change((draft) => action(draft.plan));
  }
  /** Display projection: real shelf progress joined with plan order. Never a second progress store. */
  planView() {
    this.ensureOpen();
    const plan = this.state.plan, selected = this.state.selected;
    const views = new Map(this.state.books.map((entry) => [entry.book.key, this.view(entry)]));
    const names = new Map(plan.series.map((group) => [group.id, group.name]));
    const items = plan.items.map((item, index) => {
      const book = views.get(item.bookKey);
      return { position: index + 1, id: item.id, bookKey: item.bookKey,
        title: book?.title ?? item.title, author: book?.author ?? item.author ?? '',
        source: item.source, seriesId: item.seriesId, seriesName: item.seriesId ? names.get(item.seriesId) ?? null : null,
        active: item.bookKey === selected, present: !!book, complete: book?.complete ?? false,
        progress: book?.progress ?? 0, progressUnit: book?.progressUnit ?? 'characters' as const,
        chapter: book?.chapter ?? '尚未开始', addedAt: item.addedAt,
        ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
        ...(item.notBefore !== undefined ? { notBefore: item.notBefore } : {}) };
    });
    const completed = plan.archive.filter((entry) => entry.status === 'completed');
    // The book actually being read is whatever `selected` points at, which is not
    // necessarily a planned entry: the user may have removed it from the playlist,
    // or never added it. Reporting it here is what keeps it from "disappearing".
    const selectedView = this.state.selected ? views.get(this.state.selected) : undefined;
    const reading = selectedView ? {
      bookKey: selectedView.key, title: selectedView.title, author: selectedView.author,
      progress: selectedView.progress, progressUnit: selectedView.progressUnit,
      chapter: selectedView.chapter, complete: selectedView.complete,
      inPlan: items.some((item) => item.bookKey === selectedView.key),
    } : null;
    return { id: plan.id, revision: plan.revision, enabled: plan.enabled, createdAt: plan.createdAt, updatedAt: plan.updatedAt,
      items, series: plan.series.map((group) => ({ ...group, count: items.filter((item) => item.seriesId === group.id).length })),
      total: items.length,
      // Lifetime counters, not the window: trimming the archive must never make a
      // long-time reader's finished count go down.
      completedCount: plan.stats.completed, completedKept: completed.length,
      skippedCount: plan.stats.skipped, removedCount: plan.stats.removed,
      truncatedCount: plan.stats.truncated, archiveLimit: PLAN_ARCHIVE_LIMIT, archiveKept: plan.archive.length,
      // True when the counters are the whole history; false means they are a
      // verifiable lower bound of a legacy plan whose older rows are gone.
      statsComplete: plan.statsComplete === true,
      current: items.find((item) => item.active) ?? null,
      reading,
      next: items.find((item) => !item.active && !item.complete) ?? null,
      archive: [...plan.archive].slice(-50).reverse().map((entry) => ({ ...entry })) };
  }
  /**
   * The first planned entry that can actually be read right now, evaluated
   * against a draft so it can be used inside a single atomic commit.
   *
   * `deferralStops` distinguishes the two callers: automatic hand-off stops at a
   * deferred head (the user asked for "not before X", so jumping past it would
   * overrule them), while an explicit stop skips deferred entries and looks for
   * anything readable.
   */
  private nextReadable(draft: { plan: ReadingPlan; books: BookEntry[] }, options: { exclude?: string | null; deferralStops?: boolean } = {}): { item?: PlanItem; deferred: boolean } {
    const views = new Map(draft.books.map((entry) => [entry.book.key, this.view(entry)]));
    const now = this.now();
    for (const item of draft.plan.items) {
      if (item.bookKey === options.exclude) continue;
      const view = views.get(item.bookKey);
      // A revision that left the shelf, or one already finished, can never be read.
      if (!view || view.complete) continue;
      if (item.notBefore !== undefined && item.notBefore > now) {
        if (options.deferralStops) return { deferred: true };
        continue;
      }
      return { item, deferred: false };
    }
    return { deferred: false };
  }
  /**
   * End the plan entry of a genuinely finished book and, when allowed, hand off.
   *
   * Both halves are one `change()`: a crash can never leave the plan saying
   * "still waiting to be read" while the shelf says "finished", and it can never
   * switch the selected revision while the finished entry survives as `queued`.
   * Archiving is bookkeeping, so it happens even when the hand-off itself is
   * blocked by pause, routine, rest, a pending review or a disabled plan.
   */
  completeCurrentPlanned(bookKey: string, options: { switch?: boolean } = {}): { archived: boolean; to: string | null; itemId: string | null; deferred: boolean } {
    this.ensureOpen();
    const plan = this.state.plan;
    const current = this.state.books.find((entry) => entry.book.key === bookKey);
    if (!current) throw new Error('Book revision is not in the library');
    if (!this.view(current).complete) throw new Error('Only a genuinely finished book can end its plan entry');
    const existing = findItem(plan, bookKey);
    const next = this.nextReadable(this.state, { exclude: bookKey, deferralStops: true });
    const canSwitch = options.switch !== false && !next.deferred && !!next.item;
    // Nothing to do twice: a repeated completion callback must not archive again.
    if (!existing && !canSwitch) return { archived: false, to: null, itemId: null, deferred: next.deferred };
    return this.change((draft) => {
      const item = findItem(draft.plan, bookKey);
      let archived = false;
      if (item) {
        archiveItem(draft.plan, item.id, 'completed', this.now(), 'finished_while_planned');
        archived = true;
      }
      if (!canSwitch || !next.item) return { archived, to: null, itemId: null, deferred: next.deferred };
      const entry = draft.books.find((row) => row.book.key === next.item!.bookKey);
      if (!entry) throw new Error('Next planned revision is not in the library');
      this.invalidate(draft);
      draft.selected = entry.book.key;
      const target = findItem(draft.plan, entry.book.key);
      if (target && target.startedAt === undefined) { target.startedAt = this.now(); draft.plan.revision += 1; draft.plan.updatedAt = this.now(); }
      return { archived, to: entry.book.key, itemId: target?.id ?? null, deferred: false };
    });
  }
  /** Start following the plan when nothing is selected yet. Never advances progress. */
  startPlanned(): { to: string | null; itemId: string | null; deferred: boolean } {
    this.ensureOpen();
    const next = this.nextReadable(this.state, { deferralStops: true });
    if (!next.item) return { to: null, itemId: null, deferred: next.deferred };
    const key = next.item.bookKey;
    this.selectPlanned(key);
    return { to: key, itemId: next.item.id, deferred: false };
  }
  /**
   * Append books to the plan. `bookKeys` order is the requested order. When
   * nothing is being read and the plan was empty, the first added book becomes
   * the selected one — that is starting to read, never advancing progress.
   */
  addToPlan(bookKeys: unknown, options?: { source?: PlanSource; intentId?: string; seriesId?: string | null; notBefore?: number; activate?: boolean }) {
    this.ensureOpen();
    const wanted = this.planKeys(bookKeys);
    const result = this.change((draft) => this.applyPlanAdd(draft, wanted, options));
    if (options?.activate === true && result.added.length && !this.state.selected) {
      const first = result.added[0];
      if (this.state.books.some((entry) => entry.book.key === first.bookKey)) {
        try { this.select(first.bookKey); this.updatePlan((plan) => { markStarted(plan, first.bookKey, this.now()); }); } catch { /* keep the plan; selection can be retried */ }
      }
    }
    return { ...result, view: this.planView() };
  }
  /**
   * Queue the book and update autonomous-selection state in ONE snapshot.
   *
   * The old code appended a queue row inside the same `updateSelection` write, so a
   * crash between "intent is reading" and "book is queued" could not exist. Keeping
   * that property matters more than a smaller call surface: the updater decides
   * whether the plan entry belongs in this commit, and any write failure rolls the
   * whole receipt back for a safe retry.
   */
  addToPlanAtomic(bookKeys: unknown, options: { source?: PlanSource; intentId?: string; notBefore?: number },
    selectionAction: (draft: SelectionState) => boolean) {
    this.ensureOpen();
    const wanted = this.planKeys(bookKeys);
    const result = this.change((draft) => {
      const include = selectionAction(draft.selection);
      draft.selection.generation++;
      if (!include) return { added: [], duplicates: [], archived: [], overflow: 0, missing: [] };
      return this.applyPlanAdd(draft, wanted, options);
    });
    return { ...result, view: this.planView() };
  }
  private planKeys(bookKeys: unknown): string[] {
    if (!Array.isArray(bookKeys) || bookKeys.length < 1 || bookKeys.length > 200) throw new Error('bookKeys must contain 1–200 books');
    return bookKeys.map((key) => requiredText(key, 'bookKey', 150));
  }
  private applyPlanAdd(draft: LibraryState, wanted: readonly string[], options?: { source?: PlanSource; intentId?: string; seriesId?: string | null; notBefore?: number }) {
    const source: PlanSource = options?.source === 'persona' ? 'persona' : 'user';
    const inputs: PlanAddInput[] = [];
    const missing: string[] = [];
    for (const key of wanted) {
      const entry = draft.books.find((row) => row.book.key === key);
      if (!entry) { missing.push(key); continue; }
      inputs.push({ bookKey: key, title: entry.book.title, author: entry.book.author, source,
        ...(options?.intentId ? { intentId: options.intentId } : {}),
        ...(options?.seriesId !== undefined ? { seriesId: options.seriesId } : {}),
        ...(options?.notBefore !== undefined ? { notBefore: options.notBefore } : {}) });
    }
    if (!inputs.length) throw new Error('None of these books are in the library');
    return { ...addPlanItems(draft.plan, inputs, this.now()), missing };
  }
  /**
   * Remove or skip an entry. Removing the book that is being read requires an
   * explicit stop flag, keeps the shelf copy and all progress, and never marks
   * anything read. Skipping is not completion either.
   */
  removeFromPlan(itemId: unknown, options?: { status?: 'removed' | 'skipped'; stop?: boolean; keepReading?: boolean; reason?: string }) {
    this.ensureOpen();
    const id = requiredText(itemId, 'itemId', 64);
    const status = options?.status === 'skipped' ? 'skipped' : 'removed';
    const stop = options?.stop === true;
    const target = this.state.plan.items.find((item) => item.id === id);
    if (!target) throw new Error('Reading plan entry not found');
    const active = this.state.selected === target.bookKey;
    if (active && !stop && !options?.keepReading) throw new Error('The book being read is locked; stop reading it explicitly before removing or skipping it');
    const targetView = this.state.books.find((entry) => entry.book.key === target.bookKey);
    // A finished book can only ever be recorded as finished. Letting a skip or a
    // removal rewrite it would falsify the one outcome that must stay honest.
    if (targetView && this.view(targetView).complete) {
      throw new Error('This book is already finished; its plan entry is recorded as completed, not skipped or removed');
    }
    // Stopping is "end this one and continue with the next". Without a readable
    // next revision there is nothing to continue with, so the request is refused
    // instead of leaving a book that left the plan but is still being read.
    if (active && stop) {
      const next = this.nextReadable(this.state, { exclude: target.bookKey });
      if (!next.item) throw new Error('No other planned book is readable right now; remove it from the plan while keeping it open, or pause reading');
    }
    const reason = options?.reason ?? (status === 'skipped' ? 'skipped_by_user' : 'removed_by_user');
    return this.change((draft) => {
      const entry = archiveItem(draft.plan, id, status, this.now(), reason);
      if (!entry) throw new Error('Reading plan entry not found');
      // Everything below shares this commit: archiving the entry, invalidating the
      // stopped book's pending work, selecting the next revision and stamping its
      // start. A crash can only roll the whole decision back.
      let to: string | null = null;
      if (active && stop) {
        const next = this.nextReadable(draft, { exclude: target.bookKey });
        if (!next.item) throw new Error('No other planned book is readable right now');
        this.invalidate(draft);
        draft.selected = next.item.bookKey;
        to = next.item.bookKey;
        const started = findItem(draft.plan, next.item.bookKey);
        if (started && started.startedAt === undefined) { started.startedAt = this.now(); draft.plan.revision += 1; draft.plan.updatedAt = this.now(); }
      }
      return { entry, to };
    });
  }
  /**
   * Where a waiting entry may actually land. The book being read holds its
   * place: no ordinary reorder can put another book in front of it, and the
   * active entry itself never moves (that is what "stop reading" is for).
   */
  private waitingTarget(itemId: string, target: number): number {
    const items = this.state.plan.items;
    const index = items.findIndex((item) => item.id === itemId);
    if (index < 0) throw new Error('Reading plan entry not found');
    if (items[index].bookKey === this.state.selected) throw new Error('The book being read is locked; stop reading it before moving it in the plan');
    const activeIndex = items.findIndex((item) => item.bookKey === this.state.selected);
    const floor = activeIndex >= 0 ? activeIndex + 1 : 0;
    return Math.max(floor, Math.min(target, items.length - 1));
  }
  /** Move one waiting entry to a 1-based position. Clamped; never bypasses the active lock. */
  movePlanItem(itemId: unknown, to: unknown) {
    this.ensureOpen();
    const id = requiredText(itemId, 'itemId', 64);
    if (!Number.isSafeInteger(to) || (to as number) < 1 || (to as number) > 1000) throw new Error('to must be a 1-based position');
    const target = this.waitingTarget(id, (to as number) - 1);
    const changed = this.updatePlan((plan) => movePlanItem(plan, id, target, this.now()));
    return { changed, view: this.planView() };
  }
  /** Top / bottom / right after the currently read book. */
  placePlanItem(itemId: unknown, place: unknown) {
    this.ensureOpen();
    const id = requiredText(itemId, 'itemId', 64);
    const where = String(place);
    if (!['top', 'bottom', 'next'].includes(where)) throw new Error('place must be top, bottom or next');
    const index = this.state.plan.items.findIndex((item) => item.id === id);
    if (index < 0) throw new Error('Reading plan entry not found');
    const activeIndex = this.state.plan.items.findIndex((item) => item.bookKey === this.state.selected);
    const wanted = where === 'top' ? 0 : where === 'bottom' ? this.state.plan.items.length - 1 : Math.max(0, activeIndex < 0 ? 0 : activeIndex + 1);
    const target = this.waitingTarget(id, wanted);
    const changed = this.updatePlan((plan) => movePlanItem(plan, id, target, this.now()));
    return { changed, view: this.planView() };
  }
  movePlanSeries(seriesId: unknown, to: unknown) {
    this.ensureOpen();
    const id = requiredText(seriesId, 'seriesId', 64);
    if (!Number.isSafeInteger(to) || (to as number) < 1 || (to as number) > 1000) throw new Error('to must be a 1-based position');
    const items = this.state.plan.items;
    const members = items.filter((item) => item.seriesId === id);
    if (!members.length) throw new Error('Series group has no entries');
    if (members.some((item) => item.bookKey === this.state.selected)) throw new Error('The series contains the book being read; stop reading it before moving the whole group');
    const activeIndex = items.findIndex((item) => item.bookKey === this.state.selected);
    const floor = activeIndex >= 0 ? activeIndex + 1 : 0;
    const target = Math.max(floor, Math.min((to as number) - 1, items.length - 1));
    const changed = this.updatePlan((plan) => movePlanSeries(plan, id, target, this.now()));
    return { changed, view: this.planView() };
  }
  setPlanEnabled(enabled: unknown) {
    this.ensureOpen();
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
    const changed = this.updatePlan((plan) => setPlanEnabled(plan, enabled, this.now()));
    return { changed, view: this.planView() };
  }
  /** Series editing. Auto suggestions stay unconfirmed until a human confirms them. */
  editPlanSeries(input: Record<string, unknown>) {
    this.ensureOpen();
    const action = String(input.action);
    const ids = (value: unknown, name: string): string[] => {
      if (!Array.isArray(value) || value.length < 1 || value.length > 200) throw new Error(`${name} must contain 1–200 ids`);
      return value.map((id) => requiredText(id, name, 64));
    };
    // The updater runs against a draft, so the view is always read afterwards.
    if (action === 'create') {
      const name = requiredText(input.name, 'series name', 200);
      const itemIds = ids(input.itemIds, 'itemIds');
      this.updatePlan((plan) => {
        const group = createSeries(plan, name, 'manual', true, this.now());
        for (const itemId of itemIds) setItemSeries(plan, itemId, group.id, this.now());
      });
      return this.planView();
    }
    if (action === 'rename') {
      const seriesId = requiredText(input.seriesId, 'seriesId', 64);
      const name = requiredText(input.name, 'series name', 200);
      this.updatePlan((plan) => {
        const group = plan.series.find((row) => row.id === seriesId);
        if (!group) throw new Error('Series group not found');
        group.name = name; group.updatedAt = this.now(); plan.revision += 1;
      });
      return this.planView();
    }
    if (action === 'assign') {
      const seriesId = input.seriesId === null ? null : requiredText(input.seriesId, 'seriesId', 64);
      const itemIds = ids(input.itemIds, 'itemIds');
      this.updatePlan((plan) => {
        if (seriesId && !plan.series.some((row) => row.id === seriesId)) throw new Error('Series group not found');
        for (const itemId of itemIds) setItemSeries(plan, itemId, seriesId, this.now());
        dropUnusedSeries(plan);
      });
      return this.planView();
    }
    if (action === 'confirm') {
      const seriesId = requiredText(input.seriesId, 'seriesId', 64);
      this.updatePlan((plan) => {
        const group = plan.series.find((row) => row.id === seriesId);
        if (!group) throw new Error('Series group not found');
        group.confirmed = true; group.updatedAt = this.now(); plan.revision += 1;
      });
      return this.planView();
    }
    if (action === 'delete') {
      const seriesId = requiredText(input.seriesId, 'seriesId', 64);
      this.updatePlan((plan) => {
        for (const item of plan.items) if (item.seriesId === seriesId) item.seriesId = null;
        dropUnusedSeries(plan); plan.revision += 1;
      });
      return this.planView();
    }
    throw new Error('series action must be create, rename, assign, confirm or delete');
  }
  /** Read-only grouping proposals from folder paths, shared titles and file names. */
  planSeriesSuggest() {
    this.ensureOpen();
    const candidates = this.state.plan.items.map((item) => {
      const entry = this.state.books.find((row) => row.book.key === item.bookKey);
      return { bookKey: item.bookKey, title: entry?.book.title ?? item.title,
        filename: entry?.book.filename ?? '', itemId: item.id };
    });
    return { suggestions: suggestSeries(candidates), view: this.planView() };
  }
  /**
   * One dispatcher for the panel and the model tool. Order changes never touch
   * text, keys, progress, journal, review, story index or Persona Memory.
   */
  updatePlanAction(input: Record<string, unknown>) {
    this.ensureOpen();
    switch (String(input.action)) {
      case 'move': return this.movePlanItem(input.itemId, input.to);
      case 'place': return this.placePlanItem(input.itemId, input.place);
      case 'move_series': return this.movePlanSeries(input.seriesId, input.to);
      case 'enable': return this.setPlanEnabled(input.enabled);
      case 'remove': return this.removeFromPlan(input.itemId, {
        status: input.status === 'skipped' ? 'skipped' : 'removed',
        stop: input.stop === true,
        // "Remove from the plan but keep reading this" is a different promise from
        // "stop and hand over"; both must reach Library, so both are passed on.
        keepReading: input.keepReading === true,
        reason: typeof input.reason === 'string' ? input.reason.slice(0, 200) : undefined });
      case 'series': return this.editPlanSeries(input);
      default: throw new Error('plan action must be move, place, move_series, enable, remove or series');
    }
  }
  hasPendingReviewJob(bookKey: string): boolean {
    this.ensureOpen();
    return this.state.reviewJobs.some((job) => job.bookKey === bookKey && job.status === 'pending');
  }
  nextSize(): number {
    this.ensureOpen(); const entry = this.current();
    const segment = entry.book.segments[entry.frontier];
    return segment ? segment.end - segment.start : 0;
  }
  cancelPending(): void { this.change((draft) => { this.invalidate(draft); }); }
  importCatalog(catalog: SourceCatalog, expectedGeneration: number, firstChapter?: CachedChapter) {
    const book = buildRemoteBook({ catalog, cache: firstChapter ? [firstChapter] : [] });
    return this.change((draft) => {
      if (draft.generation !== expectedGeneration) throw new SourceError('cancelled', 'Library changed during source resolution');
      const old = draft.books.find(e => e.book.key === book.key);
      if (old) {
        if (firstChapter && old.book.remote && !old.book.remote.cache.length) {
          if (draft.books.reduce((n,e)=>n+e.book.totalChars,0)+book.totalChars > MAX_LIBRARY_CHARS) throw new SourceError('limit','Library capacity reached');
          old.book=book;
        }
        return { duplicate: true, book: this.view(old) };
      }
      if (draft.books.reduce((n,e)=>n+e.book.totalChars,0)+book.totalChars > MAX_LIBRARY_CHARS) throw new SourceError('limit','Library capacity reached');
      if (draft.books.length >= 100) throw new SourceError('limit', 'Library version limit reached');
      draft.books.push({ book, frontier: 0 }); return { duplicate: false, book: this.view({ book, frontier: 0 }) };
    });
  }
  createSerial(input: { catalog: SourceCatalog; serial: SerialRecord; chapters?: CachedChapter[] }, expectedGeneration: number) {
    validateSerialCatalog(input.catalog, { bookUrl: input.serial.bookUrl });
    const chapters = (input.chapters ?? []).map((chapter, index) => ({ ...chapter, index }));
    const book = buildSerialBook({ catalog: input.catalog, cache: chapters, serial: input.serial });
    return this.change((draft) => {
      if (draft.generation !== expectedGeneration) throw new SourceError('cancelled', 'Library changed during serial subscription');
      const old = draft.books.find(e => e.book.key === book.key);
      if (old) return { duplicate: true, book: this.view(old) };
      if (draft.books.length >= 100 || draft.books.reduce((n, e) => n + e.book.totalChars, 0) + book.totalChars > MAX_LIBRARY_CHARS) throw new SourceError('limit', 'Library capacity reached');
      const entry = { book, frontier: 0, serial: book.remote!.serial! };
      draft.books.push(entry);
      return { duplicate: false, book: this.view(entry) };
    });
  }
  /** One linearized commit for a checked catalog plus an optional contiguous body prefix. */
  commitSerialSync(input: SerialSyncCommit) {
    validateSerialCatalog(input.catalog);
    const now = this.now();
    return this.change((draft) => {
      const entry = draft.books.find(e => e.book.key === input.bookKey);
      if (!entry?.book.remote?.serial) throw new SourceError('invalid_content', 'Serial book is missing from the library');
      const old = entry.book, oldSerial = entry.serial ?? old.remote!.serial!;
      if (oldSerial.subscriptionRevision !== input.expectedSubscriptionRevision) throw new SourceError('cancelled', 'Serial subscription changed during the check');
      if (oldSerial.contentVersion !== input.expectedContentVersion) throw new SourceError('cancelled', 'Serial content changed during the check');
      if (old.remote!.catalog.hash !== input.baseCatalogHash) throw new SourceError('cancelled', 'Serial catalog changed during the check');
      const base = old.remote!.catalog;
      if (input.catalog.bookUrl !== base.bookUrl || input.catalog.title !== base.title || input.catalog.author !== base.author) throw new SourceError('invalid_content', 'Serial catalog identity changed');
      if (input.catalog.chapters.length < base.chapters.length) throw new SourceError('invalid_content', 'Serial catalog shrank');
      for (let i = 0; i < base.chapters.length; i++) {
        const a = base.chapters[i], b = input.catalog.chapters[i];
        if (chapterId(a) !== chapterId(b) || a.url !== b.url || (a.revision ?? null) !== (b.revision ?? null)) throw new SourceError('invalid_content', 'Serial catalog is not a strict prefix of the accepted snapshot');
        if (a.title !== b.title) throw new SourceError('invalid_content', 'Serial chapter titles changed; this snapshot needs explicit review');
      }
      const start = old.remote!.cache.length;
      if (input.chapters.length > SERIAL_PAGE_LIMIT) throw new SourceError('limit', 'Serial batch exceeds the 20-chapter limit');
      input.chapters.forEach((chapter, i) => {
        if (chapter.index !== start + i || chapter.index >= input.catalog.chapters.length) throw new SourceError('invalid_content', 'Serial body batch is not the next contiguous range');
      });
      const cache = [...old.remote!.cache, ...input.chapters.map((chapter, i) => ({ ...chapter, index: start + i }))];
      const statusChanged = input.catalog.publicationStatus !== old.remote!.catalog.publicationStatus;
      const changed = input.catalog.hash !== base.hash || input.chapters.length > 0 || statusChanged;
      const contentVersion = oldSerial.contentVersion + (changed ? 1 : 0);
      const at = new Date(now).toISOString();
      const serial: SerialRecord = { ...oldSerial, contentVersion, publicationEvidence: input.publicationEvidence,
        lastCheck: { at, status: input.receipt.status, message: input.receipt.error ?? (input.chapters.length ? `新增 ${input.chapters.length} 章` : '目录无变化') },
        subscription: { ...oldSerial.subscription, lastAttemptAt: at, lastSuccessfulCheckAt: input.receipt.status === 'failed' ? oldSerial.subscription.lastSuccessfulCheckAt : at,
          failures: input.receipt.status === 'failed' ? oldSerial.subscription.failures + 1 : 0,
          backoffUntil: input.receipt.status === 'failed' ? (input.retryAt ?? nextCheckIso(now, 5)) : null,
          nextCheckAt: oldSerial.subscription.enabled ? (input.receipt.status === 'failed' ? (input.retryAt ?? nextCheckIso(now, 5)) : nextCheckIso(now, oldSerial.subscription.intervalMinutes)) : null } };
      const addedChapterIds = input.catalog.chapters.slice(start, start + input.chapters.length).map(chapterId);
      const receipt = receiptFor({ jobId: input.receipt.jobId, at, status: input.receipt.status, expectedVersion: oldSerial.contentVersion,
        committedVersion: contentVersion, baseCatalogHash: input.baseCatalogHash, catalogHash: input.catalog.hash,
        addedChapterIds, error: input.receipt.error });
      serial.receipts = [...oldSerial.receipts, receipt].slice(-100);
      const book = buildSerialBook({ catalog: input.catalog, cache, serial }, old);
      if (draft.books.reduce((n, e) => n + (e === entry ? book.totalChars : e.book.totalChars), 0) > MAX_LIBRARY_CHARS) throw new SourceError('limit', 'Library character limit reached');
      if (changed) for (const job of draft.reviewJobs) if (job.bookKey === input.bookKey && job.status === 'pending') { job.status = 'cancelled'; job.error = 'Serial content changed after the review snapshot; begin a new review when the new snapshot is complete'; }
      entry.book = book;
      entry.serial = book.remote!.serial!;
      return { duplicate: false, receipt, book: this.view(entry) };
    });
  }
  failSerialCheck(bookKey: string, expectedSubscriptionRevision: number, expectedContentVersion: number, error: { code: string; message: string }, backoffUntil: number | null) {
    const now = this.now(), at = new Date(now).toISOString();
    const existing = this.state.books.find(e => e.book.key === bookKey);
    if (!existing?.book.remote?.serial) return { updated: false };
    const serial = existing.serial ?? existing.book.remote.serial;
    if (serial.subscriptionRevision !== expectedSubscriptionRevision || serial.contentVersion !== expectedContentVersion) return { updated: false };
    const next: SerialRecord = { ...serial, lastCheck: { at, status: 'failed', message: error.message.slice(0, 500) },
      subscription: { ...serial.subscription, lastAttemptAt: at, failures: serial.subscription.failures + 1,
        backoffUntil: backoffUntil === null ? null : new Date(backoffUntil).toISOString(),
        nextCheckAt: serial.subscription.enabled ? (backoffUntil === null ? nextCheckIso(now, serial.subscription.intervalMinutes) : new Date(backoffUntil).toISOString()) : null } };
    return this.change((draft) => {
      const entry = draft.books.find(e => e.book.key === bookKey);
      if (!entry?.book.remote) return { updated: false };
      const current = entry.serial ?? entry.book.remote.serial;
      if (!current || current.subscriptionRevision !== expectedSubscriptionRevision || current.contentVersion !== expectedContentVersion) return { updated: false };
      entry.serial = next;
      return { updated: true, book: this.view(entry) };
    });
  }
  recordSerialConflict(bookKey: string, expectedSubscriptionRevision: number, expectedContentVersion: number, message: string) {
    const now = this.now(), at = new Date(now).toISOString();
    const existing = this.state.books.find(e => e.book.key === bookKey);
    if (!existing?.book.remote?.serial) return { updated: false };
    const serial = existing.serial ?? existing.book.remote.serial;
    if (serial.subscriptionRevision !== expectedSubscriptionRevision || serial.contentVersion !== expectedContentVersion) return { updated: false };
    const next: SerialRecord = { ...serial, lastCheck: { at, status: 'conflict', message: message.slice(0, 500) },
      subscription: { ...serial.subscription, lastAttemptAt: at, enabled: false, nextCheckAt: null, failures: serial.subscription.failures } };
    return this.change((draft) => {
      const entry = draft.books.find(e => e.book.key === bookKey);
      if (!entry?.book.remote) return { updated: false };
      const current = entry.serial ?? entry.book.remote.serial;
      if (!current || current.subscriptionRevision !== expectedSubscriptionRevision || current.contentVersion !== expectedContentVersion) return { updated: false };
      entry.serial = next;
      return { updated: true, book: this.view(entry) };
    });
  }
  setSerialSubscription(bookKey: unknown, enabled: unknown, interval: unknown = 60) {
    const key = requiredText(bookKey, 'bookKey', 150);
    if (typeof enabled !== 'boolean' || !SERIAL_INTERVALS.includes(interval as typeof SERIAL_INTERVALS[number])) throw new Error('Invalid serial subscription options');
    const now = this.now();
    return this.change((draft) => {
      const entry = draft.books.find(e => e.book.key === key);
      if (!entry?.book.remote?.serial) throw new Error('Serial book is not in the library');
      const serial = entry.serial ?? entry.book.remote.serial;
      const next: SerialRecord = { ...serial, subscriptionRevision: serial.subscriptionRevision + 1,
        subscription: { ...serial.subscription, enabled, intervalMinutes: interval as number, failures: 0, backoffUntil: null,
          nextCheckAt: enabled ? nextCheckIso(now, interval as number) : null } };
      entry.serial = next;
      return this.view(entry);
    });
  }
  serialSubscription(key: unknown = this.state.selected) {
    const entry = this.state.books.find(e => e.book.key === key);
    if (!entry?.book.remote?.serial) return null;
    return structuredClone(entry.serial ?? entry.book.remote.serial);
  }
  serialCatalog(key: unknown = this.state.selected) {
    const entry = this.state.books.find(e => e.book.key === key);
    if (!entry?.book.remote?.serial) return null;
    return structuredClone(entry.book.remote.catalog);
  }
  sourceDemand(key = this.state.selected) {
    this.ensureOpen();
    const entry = this.state.books.find(e => e.book.key === key);
    if (!entry?.book.remote) return null;
    if (entry.book.remote.serial) return null;
    const source = entry.book.remote;
    return { key: entry.book.key, generation: this.state.generation, catalog: structuredClone(source.catalog),
      index: source.cache.length, needsNext: entry.frontier === entry.book.segments.length && source.cache.length < source.catalog.chapters.length,
      paused: this.state.paused, selected: this.state.selected === key };
  }
  cacheChapter(key: string, generation: number, chapter: CachedChapter) {
    return this.change((draft) => {
      const entry = draft.books.find(e => e.book.key === key);
      if (!entry?.book.remote || entry.book.remote.serial || draft.generation !== generation) throw new SourceError('cancelled', 'Library changed while fetching a chapter');
      const old = entry.book;
      if (chapter.index !== old.remote!.cache.length) throw new SourceError('cancelled', 'Chapter cache changed during retrieval');
      const rebuilt = buildRemoteBook({ catalog: old.remote!.catalog, cache: [...old.remote!.cache, chapter] });
      if (draft.books.reduce((n, e) => n + (e === entry ? rebuilt.totalChars : e.book.totalChars), 0) > MAX_LIBRARY_CHARS) throw new SourceError('limit', 'Library character limit reached');
      if (old.segments.some((segment, i) => JSON.stringify(segment) !== JSON.stringify(rebuilt.segments[i]))) throw new SourceError('invalid_content', 'Appending a chapter would change an existing range');
      entry.book = rebuilt; return this.view(entry);
    });
  }
  sourceFailed(key: string, generation: number, error: SourceError) {
    return this.change((draft) => {
      const entry = draft.books.find(e => e.book.key === key);
      if (!entry?.book.remote || entry.book.remote.serial || draft.generation !== generation) return;
      const copy=Object.create(Object.getPrototypeOf(entry.book),Object.getOwnPropertyDescriptors(entry.book)) as Book;copy.remote={...entry.book.remote,lastError:{ code: error.code, message: error.message.slice(0, 500), at: new Date().toISOString(), chapterIndex: entry.book.remote.cache.length }};entry.book=copy;
    });
  }
  select(key: unknown) {
    const bookKey = requiredText(key, 'bookKey', 150);
    return this.change((draft) => {
      const entry = draft.books.find((e) => e.book.key === bookKey);
      if (!entry) throw new Error('Book revision is not in the library');
      if (draft.selected !== bookKey) { this.invalidate(draft); draft.selected = bookKey; }
      return this.view(entry);
    });
  }
  setPaused(value: unknown) {
    if (typeof value !== 'boolean') throw new Error('paused must be boolean');
    return this.change((draft) => {
      if (draft.paused !== value) { this.invalidate(draft); draft.paused = value; }
      return { paused: draft.paused };
    });
  }
  readNext(count = 1) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 4) throw new Error('Batch size must be 1–4 atomic segments');
    return this.change((draft) => {
      if (draft.paused) throw new Error('Reading is paused');
      const entry = this.current(draft);
      if (entry.frontier === entry.book.segments.length) {
        const serial = entry.book.remote?.serial;
        if (serial) {
          const total = entry.book.remote!.catalog.chapters.length, cached = entry.book.remote!.cache.length;
          if (cached < total) throw new SourceError('missing', `目录已发现 ${total} 章，正文已同步 ${cached} 章，等待后续正文。`);
          if (entry.book.remote!.catalog.publicationStatus !== 'finished') throw new SourceError('missing', '已读到当前目录末尾，等待更新；这不是全书完读。');
          return { complete: true as const, bookKey: entry.book.key };
        }
        if (entry.book.remote && entry.book.remote.cache.length < entry.book.remote.catalog.chapters.length) throw new SourceError('missing', 'Next chapter is not cached; retry fetching it rather than skipping it');
        if (entry.book.remote && entry.book.remote.catalog.publicationStatus !== 'finished') throw new SourceError('missing', 'This catalog snapshot has been read, but the source does not mark the novel finished; refresh the source link to check for updates');
        return { complete: true as const, bookKey: entry.book.key };
      }
      const pending = historyFind(draft.tasks,{status:'pending'});
      if (pending && pending.expiresAt <= this.now()) pending.status = 'expired';
      // Reuse the contiguous pending run that starts at the frontier and extend it
      // only when the caller asks for a larger batch. Slots are atomic segments.
      let tasks = historySelect(draft.tasks,{status:'pending'}).filter(t => t.bookKey === entry.book.key)
        .sort((a, b) => a.segmentId - b.segmentId);
      if (tasks.some((t, i) => t.segmentId !== entry.frontier + i)) {
        for (const t of tasks) t.status = 'cancelled';
        tasks = [];
      }
      const wanted = Math.min(count, entry.book.segments.length - entry.frontier);
      for (let i = tasks.length; i < wanted; i++) {
        if (draft.tasks.length >= 250000) throw new Error('Reading task history limit reached');
        const task: ReadingTask = { id: randomUUID(), bookKey: entry.book.key, segmentId: entry.frontier + i,
          generation: draft.generation, expiresAt: this.now() + LEASE_MS, status: 'pending' };
        draft.tasks.push(task); tasks.push(task);
      }
      const batch = tasks.slice(0, wanted).map(task => ({ taskId: task.id, segmentId: task.segmentId,
        expiresAt: task.expiresAt, segment: entry.book.segments[task.segmentId] }));
      const first = batch[0];
      return { complete: false as const, taskId: first.taskId, bookKey: entry.book.key, segmentId: first.segmentId,
        expiresAt: first.expiresAt, segment: first.segment, progressAdvanced: false,
        segments: batch, batch: { count: batch.length, chars: batch.reduce((n, b) => n + (b.segment.end - b.segment.start), 0) },
        source: 'external-book-text' as const };
    });
  }
  /** Confirmed character offset of the next unread run, for pacing and budget display. */
  nextBatchChars(count = 1) {
    this.ensureOpen(); const entry = this.current();
    let total = 0;
    for (let i = 0; i < count; i++) { const segment = entry.book.segments[entry.frontier + i]; if (!segment) break; total += segment.end - segment.start; }
    return total;
  }
  /** Read-only idempotency probe: a confirmation replay is only safe for already committed ranges. */
  isCommitted(taskId: unknown): boolean {
    this.ensureOpen();
    if (typeof taskId !== 'string') return false;
    return historyFind(this.state.tasks,{id:taskId})?.status === 'committed';
  }
  /**
   * The book a pending task belongs to. A task id already proves which revision
   * the model was handed, so the World does not need to trust a bookKey echoed
   * back by the model — and a dropped bookKey must not turn a valid confirmation
   * into "Unknown reading range".
   */
  bookKeyOfTask(taskId: unknown): string | undefined {
    this.ensureOpen();
    if (typeof taskId !== 'string') return undefined;
    return historyFind(this.state.tasks,{id:taskId})?.bookKey;
  }
  finish(input: Record<string, unknown>,rest?:RestRecord) {
    return this.change((draft) => this.commitConfirmation(draft, input, rest, false));
  }
  /**
   * Confirm an ordered run of atomic segments. Each item is committed in its own
   * snapshot so a mid-batch failure still advances only the reliably processed
   * prefix; the rest stays unread and can be fetched again.
   */
  finishMany(rawItems: unknown, rest?:RestRecord, options?:{ episode?: unknown }) {
    this.ensureOpen();
    if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 4) throw new Error('Batch confirmation must contain 1–4 segments in reading order');
    const before = this.current();
    // One optional episode for the whole batch. It must cite at least one segment
    // supplied by this batch and is attached to the latest cited one, so all of
    // its quotations stay inside the confirmed prefix at commit time.
    let prepared: unknown[] = rawItems;
    if (options?.episode !== undefined) {
      const episode = record(options.episode, 'episode');
      const evidence = Array.isArray(episode.evidence) ? episode.evidence : [];
      const cited = new Set<number>();
      for (const entry of evidence) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const id = (entry as Record<string, unknown>).segmentId;
          if (Number.isSafeInteger(id) && (id as number) >= 0) cited.add(id as number);
        }
      }
      let target = -1;
      for (let i = 0; i < rawItems.length; i++) {
        const item = rawItems[i];
        if (item && typeof item === 'object' && !Array.isArray(item) && cited.has(Number((item as Record<string, unknown>).segmentId))) target = i;
      }
      if (target < 0) throw new Error('A batch episode must quote at least one segment supplied in this batch');
      const targetItem = rawItems[target] as Record<string, unknown>;
      if (targetItem.episode !== undefined) throw new Error('Attach an episode either to the batch or to one confirmation, not both');
      prepared = rawItems.map((item, index) => index === target
        ? { ...(item as Record<string, unknown>), episode: options.episode }
        : item);
    }
    const receipts: Receipt[] = [];
    let stoppedAt: { index: number; taskId: string; segmentId: number | null; error: string } | undefined;
    for (let index = 0; index < prepared.length; index++) {
      const item = prepared[index];
      if (!item || typeof item !== 'object' || Array.isArray(item)) { stoppedAt = { index, taskId: '', segmentId: null, error: 'Each batch item must be an object' }; break; }
      const value = item as Record<string, unknown>;
      try {
        const result = this.change((draft) => this.commitConfirmation(draft, { ...value, bookKey: value.bookKey ?? before.book.key },
          index === prepared.length - 1 ? rest : undefined, true));
        receipts.push(result.receipt);
      } catch (error) {
        stoppedAt = { index, taskId: String(value.taskId ?? ''), segmentId: Number.isSafeInteger(value.segmentId) ? value.segmentId as number : null,
          error: String((error as Error)?.message ?? error).slice(0, 500) };
        break;
      }
    }
    const entry = this.current();
    return { duplicate: receipts.length === 0 && stoppedAt === undefined, receipts, confirmed: receipts.length,
      frontier: entry.frontier, confirmedChars: entry.frontier ? entry.book.segments[entry.frontier - 1].end : 0,
      ...(stoppedAt ? { stoppedAt } : {}) };
  }
  private commitConfirmation(draft: LibraryState, input: Record<string, unknown>, rest: RestRecord | undefined, lenientDuplicate: boolean) {
    const taskId = requiredText(input.taskId, 'taskId', 80);
    const bookKey = requiredText(input.bookKey, 'bookKey', 150);
    const understanding = input.understanding === undefined || input.understanding === null ? ''
      : typeof input.understanding === 'string' && Array.from(input.understanding).length <= 600 ? input.understanding
      : (() => { throw new Error('understanding must be a string of at most 600 characters; an empty string means you have nothing to add'); })();
    if (!integer(input.segmentId)) throw new Error('segmentId must be a non-negative integer');
    const task = historyFind(draft.tasks,{id:taskId});
    if (!task || task.bookKey !== bookKey || task.segmentId !== input.segmentId) throw new Error('Task does not match the provided range');
    if (task.status === 'committed') {
      const saved = historyFind(draft.episodes,{id:task.receipt!.episodeId});
      const entry = draft.books.find(e => e.book.key === bookKey)!;
      if (!lenientDuplicate) {
        const retryContent = input.episode === undefined ? undefined : normalizeEpisode(input.episode, entry, (saved?historySelect(draft.episodes,{before:saved.sequence}):draft.episodes), task.segmentId + 1, entry.skip ?? 0);
        if (JSON.stringify(retryContent) !== JSON.stringify(saved?.content)) throw new Error('Confirmation retry must match the original episode; add a later reflection instead');
        if (task.receipt!.understanding !== understanding) throw new Error('Confirmation retry must match the original content');
      }
      return { duplicate: true, receipt: task.receipt! };
    }
    if (task.status !== 'pending' || task.generation !== draft.generation || draft.selected !== bookKey || draft.paused || task.expiresAt <= this.now()) throw new Error('Reading task is cancelled or expired; fetch the next range again');
    const entry = this.current(draft);
    if (entry.frontier !== task.segmentId) throw new Error('Range is not the next unread segment');
    let episode: ReadingEpisode | undefined;
    if (input.episode !== undefined) {
      const content = normalizeEpisode(input.episode, entry, draft.episodes, entry.frontier + 1, entry.skip ?? 0);
      if (!content.evidence.some(e => e.segmentId === task.segmentId)) throw new Error('Reading episode must cite the current task segment');
      episode = this.appendEpisode(draft, { kind: 'reading', bookKey, taskId, content });
    }
    entry.frontier++;
    task.status = 'committed';
    task.receipt = { taskId, bookKey, segmentId: task.segmentId, frontier: entry.frontier,
      confirmedChars: entry.book.segments[task.segmentId].end, understanding, confirmedAt: this.now(), ...(episode ? { episodeId: episode.id } : {}) };
    if(rest){if(rest.bookKey!==bookKey)throw Error('Rest book mismatch');const duration=rest.plannedUntil-rest.startedAt;const actual={...rest,startedAt:task.receipt.confirmedAt!,plannedUntil:task.receipt.confirmedAt!+duration};draft.rests=[...(draft.rests??[]),actual].slice(-1000);}
    return { duplicate: false, receipt: task.receipt };
  }
  private goalCache?:{key:string;count:number};
  dailyChapters(day:string,timezone:string){
    const key=String(this.historyRef?.version??this.state.nextEpisodeSequence)+':'+day+':'+timezone;
    if(this.goalCache?.key===key)return this.goalCache.count;
    const ends=new Map(this.state.books.map(e=>[e.book.key,chapterEndIds(e.book)]));const date=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});let count=0;
    for(const task of historySelect(this.state.tasks,{status:'committed'})){const r=task.receipt;if(r?.confirmedAt!==undefined&&ends.get(task.bookKey)?.has(task.segmentId)&&date.format(r.confirmedAt)===day)count++;}
    this.goalCache={key,count};return count;
  }
  segmentSize(key:unknown,index:unknown){const entry=this.state.books.find(e=>e.book.key===key);if(!entry||!integer(index)||index>=entry.book.segments.length)throw Error('Unknown reading range');const s=entry.book.segments[index];return s.end-s.start;}
  planRest(durationMs:number,readingMs:number,source:RestRecord['source']):RestRecord{
    const book=this.current().book;const now=this.now();return {id:randomUUID(),bookKey:book.key,startedAt:now,plannedUntil:now+Math.max(1,Math.round(durationMs)),endedAt:null,state:'scheduled',source,readingMs};
  }
  timelineRestRevision(){const rests=this.state.rests??[];const last=rests.at(-1);return String(rests.length)+':'+(last?.id??'')+':'+(last?.state??'');}
  activeRest(){const r=this.state.rests?.find(r=>r.state==='scheduled');return r?structuredClone(r):undefined;}
  recordRest(rest:RestRecord){return this.change(d=>{if(d.rests?.some(r=>r.state==='scheduled'))throw Error('Rest already scheduled');d.rests=[...(d.rests??[]),rest].slice(-1000);return rest;});}
  endRest(state:RestRecord['state']='ended',unknownEnd=false){if(!this.activeRest())return;this.change(d=>{for(const r of d.rests??[])if(r.state==='scheduled'){r.state=state;r.endedAt=unknownEnd?null:Math.max(r.startedAt,Math.min(this.now(),r.plannedUntil));}});}
  private appendEpisode(draft: LibraryState, value: Omit<ReadingEpisode, 'id' | 'sequence' | 'recordedAt'>): ReadingEpisode {
    if (draft.episodes.length >= MAX_EPISODES || draft.nextEpisodeSequence >= Number.MAX_SAFE_INTEGER) throw new Error('Reading journal is full');
    const episode = { id: randomUUID(), sequence: draft.nextEpisodeSequence++, recordedAt: new Date(this.now()).toISOString(), ...value };
    draft.episodes.push(episode); return episode;
  }
  reflect(input: Record<string, unknown>) {
    const bookKey = requiredText(input.bookKey, 'bookKey', 150);
    const requestId = requiredText(input.requestId, 'requestId', 80);
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw new Error('requestId must be an idempotency token of letters, digits, underscore or hyphen');
    return this.change(draft => {
      const entry = draft.books.find(e => e.book.key === bookKey);
      if (!entry) throw new Error('Book revision is not in the library');
      const existing = historyFind(draft.episodes,{requestId});
      const content = normalizeEpisode(input.episode, entry, existing ? historySelect(draft.episodes,{before:existing.sequence}) : draft.episodes, entry.frontier, entry.skip ?? 0);
      const revises = input.revises === undefined ? undefined : requiredText(input.revises, 'revises', 80);
      if (existing) {
        if (existing.bookKey !== bookKey || existing.revises !== revises || JSON.stringify(existing.content) !== JSON.stringify(content)) throw new Error('Reflection retry must match the original request');
        return { duplicate: true, episode: existing };
      }
      if (revises && !historyFind(draft.episodes,{id:revises,bookKey})) throw new Error('Revision target must be an earlier record from this exact revision');
      const episode = this.appendEpisode(draft, { bookKey, kind: revises ? 'revision' : 'reflection', requestId, content, ...(revises ? { revises } : {}) });
      return { duplicate: false, episode };
    });
  }
  search(input: Record<string, unknown>) {
    this.ensureOpen(); const key = input.bookKey ?? this.state.selected;
    const entry = this.state.books.find(e => e.book.key === key);
    if (!entry) throw new Error('Select an exact book revision first');
    return searchReading(entry, this.state.episodes, this.state.tasks, input);
  }
  context(input: Record<string, unknown>) {
    this.ensureOpen(); const key = input.bookKey ?? this.state.selected;
    const entry = this.state.books.find(e => e.book.key === key);
    if (!entry) throw new Error('Select an exact book revision first');
    return readingContext(entry, this.state.episodes, this.state.tasks, input);
  }
  journal(bookKey: unknown = this.state.selected, before?: unknown, limit: unknown = 5) {
    this.ensureOpen();
    const entry = this.state.books.find(e => e.book.key === bookKey);
    if (!entry) throw new Error('Select a book revision first');
    if ((before !== undefined && (!integer(before) || before < 1)) || !integer(limit) || limit < 1 || limit > 20) throw new Error('Invalid journal page (limit 1–20)');
    const total=historyCount(this.state.episodes,{bookKey});
    const matching=historyPage(this.state.episodes,{bookKey,...(before===undefined?{}:{before:before as number})},(limit as number)+1);
    const page=matching.slice(0,limit);
    const noted=historyCount(this.state.episodes,{bookKey,kind:'reading'});
    const lastMood=historyPage(this.state.episodes,{bookKey,hasMood:true},1)[0];
    const cacheKey=(this.historyRef?.version??this.state.nextEpisodeSequence)+':'+bookKey;let characterIndex=this.characterCache.get(cacheKey);
    if(!characterIndex){const characters=new Map<string,{name:string;aliases:Set<string>;episodeIds:string[];count:number}>();let truncated=false;
      for(const e of historySelect(this.state.episodes,{bookKey}))for(const c of e.content.characters){let item=characters.get(c.name);if(!item){if(characters.size>=50){truncated=true;continue;}item={name:c.name,aliases:new Set(),episodeIds:[],count:0};characters.set(c.name,item);}for(const alias of c.aliases)if(item.aliases.size<9)item.aliases.add(alias);item.episodeIds.push(e.id);if(item.episodeIds.length>20)item.episodeIds.shift();item.count++;}
      characterIndex={characters:[...characters.values()].map(c=>({name:c.name,aliases:[...c.aliases].slice(0,8),episodeIds:c.episodeIds,aliasesTruncated:c.aliases.size>8,episodeLinksTruncated:c.count>20})),truncated};this.characterCache.set(cacheKey,characterIndex);while(this.characterCache.size>4)this.characterCache.delete(this.characterCache.keys().next().value!);
    }
    return structuredClone({ bookKey, total, confirmedRanges: entry.frontier - (entry.skip ?? 0), rangesWithoutReadingEpisode: Math.max(0, entry.frontier - (entry.skip ?? 0) - noted),
      mood: lastMood ? { ...lastMood.content.mood!, recordedAt: lastMood.recordedAt, episodeId: lastMood.id, kind: lastMood.kind, isCurrentMentalState: false } : null,
      items: page.map(e => ({ id: e.id, sequence: e.sequence, recordedAt: e.recordedAt, kind: e.kind, revises: e.revises ?? null,
        trigger: e.content.trigger, interpretation: e.content.interpretation, mood: e.content.mood,
        chapters: [...new Set(e.content.evidence.map(q => entry.book.segments[q.segmentId].chapter))],
        segmentIds: [...new Set(e.content.evidence.map(q => q.segmentId))] })),
      nextBefore: matching.length > page.length ? page.at(-1)!.sequence : null,
      // Model-supplied names/aliases remain separate by name; no inferred entity merges.
      characters:characterIndex.characters,
      characterIndexTruncated:characterIndex.truncated, authorship: 'model-reported-reading-journal', interpretationVerified: false,
    });
  }
  timeline(bookKey: unknown = this.state.selected, before?: unknown, limit: unknown = 20) {
    this.ensureOpen(); const entry = this.state.books.find(e => e.book.key === bookKey);
    if (!entry) throw new Error('Select a book revision first');
    if ((before !== undefined && !integer(before)) || !integer(limit) || limit < 1 || limit > 50) throw new Error('Invalid timeline page');
    const all = historyPage(this.state.tasks,{bookKey,status:'committed',...(before===undefined?{}:{before:before as number})},(limit as number)+1);
    const page = all.slice(0, limit);
    const lower=all.length>page.length?(page.at(-1)?.receipt?.confirmedAt??0):0;const upper=before===undefined?Infinity:(historyPage(this.state.tasks,{bookKey,before:(before as number)+1,status:'committed'},1)[0]?.receipt?.confirmedAt??Infinity);
    const rests=(this.state.rests??[]).filter(r=>r.bookKey===bookKey&&r.startedAt>=lower&&r.startedAt<upper).slice(-50).reverse();
    return { bookKey, rests, pageChars: 600, items: page.map(t => { const segment = entry.book.segments[t.segmentId]; const episode = historyFind(this.state.episodes,{id:t.receipt!.episodeId,taskId:t.id,bookKey,kind:'reading'}); return { mood: episode?.content.mood ? { ...episode.content.mood } : null, id: t.id, segmentId: t.segmentId, confirmedAt: t.receipt!.confirmedAt ?? null, chapter: segment.chapter, startPage: Math.floor(segment.start/600)+1, endPage: Math.ceil(segment.end/600), summary: t.receipt!.understanding, episodeId: t.receipt!.episodeId ?? null }; }), nextBefore: all.length > page.length ? page.at(-1)!.segmentId : null };
  }
  episode(id: unknown) {
    this.ensureOpen();
    const episode = historyFind(this.state.episodes,{id});
    if (!episode) throw new Error('Episode is not in the journal');
    const entry = this.state.books.find(e => e.book.key === episode.bookKey)!;
    return structuredClone({ episode:plainHistory(episode), book: { key: entry.book.key, title: entry.book.title, revision: entry.book.revision },
      evidence: episode.content.evidence.map(e => evidenceView(entry, e)),
      revisions: historySelect(this.state.episodes,{revises:episode.id}).map(e => ({ id: e.id, recordedAt: e.recordedAt })),
      authorship: 'model-reported-reading-journal', interpretationVerified: false, recordedAtMeaning: 'time-recorded-not-recovered-past-feeling' });
  }
  /** Read-only cross-book footprint browser: same visible fields as journal().items, plus book metadata. */
  journalBrowse(input: unknown): BrowsePage {
    this.ensureOpen();
    const query = parseBrowseQuery(input);
    this.requireBookScope(query.bookKey);
    const filter: HistoryFilter = query.bookKey ? { bookKey: query.bookKey } : {};
    const terms = query.terms;
    const total = this.countEpisodes(filter, terms);
    const extremes = this.episodeExtremes(filter, terms);
    const window = this.browseWindowFor(query, filter, terms);
    const fetched = this.selectEpisodes(window.filter, window.queryOrder, query.limit + 1, terms);
    let page = fetched.slice(0, query.limit);
    // The SQL direction follows the cursor edge; the display direction follows the user's order.
    if (window.queryOrder !== query.order) page = [...page].reverse();
    const first = page[0], last = page[page.length - 1];
    let start = 0, end = 0;
    if (page.length) {
      start = 1 + (query.order === 'desc'
        ? this.countEpisodes({ ...filter, after: first!.sequence }, terms)
        : this.countEpisodes({ ...filter, before: first!.sequence }, terms));
      end = start + page.length - 1;
    }
    const entries = new Map(this.state.books.map((entry) => [entry.book.key, entry]));
    return {
      scope: { bookKey: query.bookKey }, order: query.order, limit: query.limit, query: terms, total,
      position: { start, end },
      page: { count: page.length, firstSequence: first?.sequence ?? null, lastSequence: last?.sequence ?? null },
      headSequence: extremes.head, tailSequence: extremes.tail,
      hasPrev: start > 1, hasNext: page.length > 0 && end < total,
      prevCursor: page.length ? { edge: query.order === 'desc' ? 'after' : 'before', sequence: first!.sequence } : null,
      nextCursor: page.length ? { edge: query.order === 'desc' ? 'before' : 'after', sequence: last!.sequence } : null,
      items: page.map((episode) => browseItem(episode, this.entryForEpisode(episode.bookKey, entries))),
    };
  }
  /**
   * Page window for one request. An anchor means "the page that contains this record", aligned to
   * the page-size grid: its rank is counted, the offset inside its page is filled from the nearest
   * neighbours, and the query starts at that page's first record. Restoring a saved page anchor
   * (which is always a page's first record) therefore lands on the same page, while "back to latest"
   * in ascending order returns the real last page instead of a one-record tail.
   */
  private browseWindowFor(query: BrowseQuery, filter: HistoryFilter, terms: readonly string[]): { filter: HistoryFilter; queryOrder: BrowseOrder } {
    if (query.cursor || query.anchor === null) return browseWindow(query);
    const anchor = query.anchor;
    const rank = 1 + (query.order === 'desc'
      ? this.countEpisodes({ ...filter, after: anchor }, terms)
      : this.countEpisodes({ ...filter, before: anchor }, terms));
    const offset = (rank - 1) % query.limit;
    let start = anchor;
    if (offset > 0) {
      const neighbours = query.order === 'desc'
        ? this.selectEpisodes({ ...filter, after: anchor }, 'asc', offset, terms)
        : this.selectEpisodes({ ...filter, before: anchor }, 'desc', offset, terms);
      // A deleted anchor may sit near a boundary; fall back to the anchor-as-start window.
      if (neighbours.length < offset) return browseWindow(query);
      start = neighbours[neighbours.length - 1]!.sequence;
    }
    return { filter: { ...filter, ...(query.order === 'desc' ? { upTo: start } : { downTo: start }) }, queryOrder: query.order };
  }
  /** One aggregate query for the book selector; never a per-book journal() loop. */
  journalBooks(): BrowseBooks {
    this.ensureOpen();
    const aggregates = this.historyRef ? this.history.bookAggregates(this.historyRef.version) : this.episodeBookAggregates();
    const entries = new Map(this.state.books.map((entry) => [entry.book.key, entry]));
    const books: BrowseBooks['books'] = [];
    let total = 0;
    for (const aggregate of aggregates) {
      const entry = entries.get(aggregate.bookKey);
      if (!entry || !aggregate.count) continue;
      total += aggregate.count;
      books.push({ bookKey: entry.book.key, id: entry.book.id, revision: entry.book.revision,
        title: entry.book.title, author: entry.book.author, count: aggregate.count, lastSequence: aggregate.head });
    }
    return { total, books };
  }
  /** Lightweight new-footprint probe for the 2s trail tick; returns aggregates only. */
  journalProbe(input: unknown): BrowseProbe {
    this.ensureOpen();
    const query = parseProbeQuery(input);
    this.requireBookScope(query.bookKey);
    const filter: HistoryFilter = query.bookKey ? { bookKey: query.bookKey } : {};
    const extremes = this.episodeExtremes(filter);
    return {
      total: this.countEpisodes(filter), headSequence: extremes.head, tailSequence: extremes.tail,
      count: query.since === null ? 0 : this.countEpisodes({ ...filter, after: query.since }),
    };
  }
  /** One new-footprint batch for the temporary preview; the batch boundary is fixed at query time. */
  journalNew(input: unknown): BrowseNew {
    this.ensureOpen();
    const query = parseNewQuery(input);
    this.requireBookScope(query.bookKey);
    const filter: HistoryFilter = query.bookKey ? { bookKey: query.bookKey } : {};
    const count = this.countEpisodes({ ...filter, after: query.since });
    const extremes = this.episodeExtremes(filter);
    // The preview always shows at most 50 records; `truncated` tells the UI when the batch was larger.
    const rows = this.selectEpisodes({ ...filter, after: query.since }, query.order, 50);
    const entries = new Map(this.state.books.map((entry) => [entry.book.key, entry]));
    return {
      count, maxSequence: extremes.head,
      items: rows.map((episode) => browseItem(episode, this.entryForEpisode(episode.bookKey, entries))),
      truncated: count > rows.length,
    };
  }
  private requireBookScope(bookKey: string | null): void {
    if (bookKey && !this.state.books.some((entry) => entry.book.key === bookKey)) throw new Error('Book revision is not in the library');
  }
  private entryForEpisode(bookKey: string, entries: Map<string, BookEntry>): BookEntry {
    const entry = entries.get(bookKey);
    if (!entry) throw new Error('Episode references a missing book revision');
    return entry;
  }
  private countEpisodes(filter: HistoryFilter, terms: readonly string[] = []): number {
    if (terms.length) {
      return this.historyRef ? this.history.searchCount(this.historyRef.version, filter, terms) : historySelect(this.state.episodes, filter).filter((episode) => footprintMatches(episode, terms)).length;
    }
    return this.historyRef ? this.history.countRows('episodes', this.historyRef.version, filter) : historyCount(this.state.episodes, filter);
  }
  private selectEpisodes(filter: HistoryFilter, order: BrowseOrder, limit: number, terms: readonly string[] = []): ReadingEpisode[] {
    if (this.historyRef) {
      return terms.length
        ? this.history.searchRows<ReadingEpisode>(this.historyRef.version, filter, terms, order, limit)
        : this.history.windowRows<ReadingEpisode>('episodes', this.historyRef.version, filter, order, limit);
    }
    const rows = terms.length
      ? historySelect(this.state.episodes, filter).filter((episode) => footprintMatches(episode, terms))
      : historySelect(this.state.episodes, filter);
    return rows.sort((a, b) => (order === 'asc' ? a.sequence - b.sequence : b.sequence - a.sequence)).slice(0, limit);
  }
  private episodeExtremes(filter: HistoryFilter, terms: readonly string[] = []): { head: number | null; tail: number | null } {
    if (this.historyRef) {
      return terms.length
        ? this.history.searchExtremes(this.historyRef.version, filter, terms)
        : this.history.sequenceExtremes(this.historyRef.version, filter);
    }
    const rows = terms.length
      ? historySelect(this.state.episodes, filter).filter((episode) => footprintMatches(episode, terms))
      : historySelect(this.state.episodes, filter);
    let head: number | null = null, tail: number | null = null;
    for (const episode of rows) {
      if (head === null || episode.sequence > head) head = episode.sequence;
      if (tail === null || episode.sequence < tail) tail = episode.sequence;
    }
    return { head, tail };
  }
  private episodeBookAggregates(): Array<{ bookKey: string; count: number; head: number; tail: number }> {
    const map = new Map<string, { bookKey: string; count: number; head: number; tail: number }>();
    for (const episode of historySelect(this.state.episodes)) {
      const row = map.get(episode.bookKey) ?? { bookKey: episode.bookKey, count: 0, head: episode.sequence, tail: episode.sequence };
      row.count += 1;
      if (episode.sequence > row.head) row.head = episode.sequence;
      if (episode.sequence < row.tail) row.tail = episode.sequence;
      map.set(episode.bookKey, row);
    }
    return [...map.values()].sort((a, b) => b.head - a.head);
  }
  reread(key: unknown, index: unknown) {
    this.ensureOpen();
    const entry = this.state.books.find((e) => e.book.key === key);
    if (!entry || !integer(index) || index >= entry.frontier || index < (entry.skip ?? 0)) throw new Error('Only confirmed segments may be recalled');
    return { bookKey: entry.book.key, segment: structuredClone(entry.book.segments[index]), progressAdvanced: false, source: 'external-book-text' };
  }
  remove(key: unknown) {
    const result = this.change((draft) => {
      if (!draft.books.some((e) => e.book.key === key)) throw new Error('Book is not in the library');
      this.invalidate(draft);
      draft.books = draft.books.filter((e) => e.book.key !== key);
      draft.rests=(draft.rests??[]).filter(r=>r.bookKey!==key);
      draft.tasks = draft.tasks.filter((t) => t.bookKey !== key);
      draft.episodes = draft.episodes.filter(e => e.bookKey !== key);
      draft.reviews = draft.reviews.filter(e => e.bookKey !== key); draft.reviewJobs = draft.reviewJobs.filter(e => e.bookKey !== key);
      if (draft.selected === key) draft.selected = null;
      // Deleting the book is an explicit user action that ends the pet's own commitment.
      for (const intent of draft.selection.intents) {
        if (intent.bookKey === key && !['completed', 'abandoned'].includes(intent.status)) {
          intent.status = 'abandoned'; intent.updatedAt = this.now();
          intent.failure = { code: 'book_not_found', message: '用户删除了这本书，自选书承诺已结束。', at: this.now() };
        }
      }
      draft.selection.queue = draft.selection.queue.filter((item) => item.bookKey !== key);
      return { removed: true };
    });
    let storyCleanupError: string | null = null;
    try { this.cleanupStoryBook(String(key)); }
    catch (error) {
      storyCleanupError = String(error); this.storyError = storyCleanupError;
      try { if (this.story) this.story.recordCleanup(String(key), storyCleanupError); else this.writeCleanupTombstone(String(key), storyCleanupError); }
      catch (writeError) {
        try { this.writeCleanupTombstone(String(key), storyCleanupError); }
        catch (tombstoneError) { storyCleanupError = `${storyCleanupError}; tombstone: ${String(writeError)} / ${String(tombstoneError)}`; this.storyError = storyCleanupError; }
      }
    }
    return storyCleanupError ? { ...result, storyCleanupError } : result;
  }
  writeArchive(file:string) {
    this.ensureOpen();if(this.options.write)return this.bookStorage.writeArchive(file,this.state);
    const generation=this.state.generation,historyVersion=this.historyRef?.version,storyChangeSeq=this.story?.status().changeSeq;
    const snapshot=join(this.dir,randomUUID()+'.history-backup.sqlite');
    const storySnapshot=this.story?join(this.dir,randomUUID()+'.story-backup.sqlite'):undefined;
    this.archiving=true;
    try{
      this.options.onArchiveSnapshot?.();
      this.history.snapshot(snapshot);
      if(this.story) this.story.snapshot(storySnapshot!);
      if(this.state.generation!==generation||this.historyRef?.version!==historyVersion||this.story?.status().changeSeq!==storyChangeSeq)
        throw new Error('Archive snapshot changed while reading; retry');
      return this.bookStorage.writeArchive(file,this.state,{file:snapshot,ref:this.historyRef!},storySnapshot?{file:storySnapshot}:undefined);
    }finally{
      this.archiving=false;
      if(existsSync(snapshot))unlinkSync(snapshot);
      if(storySnapshot&&existsSync(storySnapshot))unlinkSync(storySnapshot);
    }
  }
  restoreArchive(file:string, hooks?:ArchiveHooks) {
    this.ensureOpen();if(this.state.books.length)throw Error('Restore requires an empty library');let installed=false;
    const markerTmp = this.restoreMarker + '.' + randomUUID() + '.tmp';
    writeFileSync(markerTmp, JSON.stringify({ file, startedAt: this.now() }));
    renameSync(markerTmp, this.restoreMarker);
    try{
      const result=this.bookStorage.readArchive(file,(database,ref,raw)=>{
        const source=new HistoryStore(database,true);try{source.open();const restored=validateState(source.hydrate(raw,ref as HistoryRef));this.change(draft=>{Object.assign(draft,restored,{tasks:historyFork(restored.tasks),episodes:historyFork(restored.episodes)});this.invalidate(draft);this.pauseSerialAfterRestore(draft);});installed=true;return this.state;}finally{source.close();}
      },(storyFile)=>{
        if(!this.story) {
          if(storyFile) throw new Error('备份包含故事记忆；请先在设置中开启“故事记忆索引（实验）”并重新挂载后再恢复，不能静默丢弃故事索引。This backup contains story memory; enable story memory and remount before restoring it.');
          return;
        }
        if(storyFile) this.story.restoreFrom(storyFile); else this.story.clear();
      },{
        ...hooks,
        validateHistory: hooks?.validateHistory ?? ((snapshot,ref)=>this.history.validateSnapshot(snapshot,ref as HistoryRef)),
        validateStory: hooks?.validateStory ?? (snapshot=>StoryStore.validateSnapshot(snapshot)),
      }) as LibraryState;
      if(!installed){const restored=validateState(result);this.change(draft=>{Object.assign(draft,restored,{tasks:historyFork(restored.tasks),episodes:historyFork(restored.episodes)});this.invalidate(draft);this.pauseSerialAfterRestore(draft);});}
      return {restoredBooks:this.state.books.length};
    }catch(error){
      // A failed restore must not leave a half-installed library or sidecar.
      try { this.clear(); } catch {}
      this.bookStorage.collect(this.state);
      throw error;
    } finally {
      if (existsSync(this.restoreMarker)) unlinkSync(this.restoreMarker);
    }
  }
  export() {
    this.ensureOpen();
    if(this.state.books.reduce((n,e)=>n+e.book.totalChars,0)>4*1024*1024)throw new Error('Use the chunked .bfbak backup for large libraries');
    if(this.state.tasks.length+this.state.episodes.length>10000)throw Error('Use .bfbak for large reading histories');
    const payload = JSON.stringify(this.state);
    return JSON.stringify({ format: 'bookfish-backup-v1', checksum: digest(payload), payload });
  }
  clear() {
    const result = this.change((draft) => {
      this.invalidate(draft); draft.books = []; draft.tasks = []; draft.episodes = []; draft.selected = null; draft.reviews = []; draft.reviewJobs = []; draft.selection = emptySelection();
      return 'Bookfish books and progress cleared';
    });
    let storyCleanupError: string | null = null;
    try {
      if (this.story) this.story.clear();
      else {
        const file = join(this.dir, 'story.sqlite');
        if (existsSync(file)) { const store = new StoryStore(file, { now: this.now }); try { store.open(); store.clear(); } finally { store.close(); } }
      }
      if (existsSync(this.storyCleanupFile)) unlinkSync(this.storyCleanupFile);
    } catch (error) { storyCleanupError = String(error); this.storyError = storyCleanupError; }
    return storyCleanupError ? `${result} (story cleanup failed: ${storyCleanupError})` : result;
  }
  restore(text: unknown) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 25 * 1024 * 1024) throw new Error('Invalid or oversized backup');
    const envelope = JSON.parse(text);
    if (envelope.format !== 'bookfish-backup-v1' || typeof envelope.payload !== 'string' || digest(envelope.payload) !== envelope.checksum) throw new Error('Backup checksum does not match');
    const restored = validateState(JSON.parse(envelope.payload));
    return this.change((draft) => {
      if (draft.books.length) throw new Error('Restore requires an empty library; export existing books first');
      Object.assign(draft, restored,{tasks:historyFork(restored.tasks),episodes:historyFork(restored.episodes)});
      this.invalidate(draft);
      this.pauseSerialAfterRestore(draft);
      return { restoredBooks: draft.books.length };
    });
  }
  beginReview(args: Record<string, unknown>) { return this.change(state => beginReview(state, args, this.now())); }
  reviewMaterials(args: Record<string, unknown>) { return this.change(state => reviewMaterials(state, args, this.now())); }
  finishReview(args: Record<string, unknown>) { return this.change(state => finishReview(state, args, this.now())); }
  failReview(args: Record<string, unknown>) { return this.change(state => failReview(state, args)); }
  reviews(bookKey: unknown = this.state.selected) {
    this.ensureOpen(); const book = this.state.books.find(e => e.book.key === bookKey);
    if (!book) throw new Error('Select an exact revision');
    return structuredClone({ bookKey, complete: this.view(book).complete,
      jobs: this.state.reviewJobs.filter(j => j.bookKey === bookKey).map(j => ({ ...j, rangesSeen: j.rangesSeen.length, episodesSeen: j.episodesSeen.length })),
      versions: this.state.reviews.filter(r => r.bookKey === bookKey).map(r => ({ id: r.id, version: r.version, title: r.title, recordedAt: r.recordedAt, previousId: r.previousId })) });
  }
  review(id: unknown) { this.ensureOpen(); const r = this.state.reviews.find(r => r.id === id); if (!r) throw new Error('Review missing');
    const entry = this.state.books.find(e => e.book.key === r.bookKey)!;
    return structuredClone({ review: r, book: { key: entry.book.key, title: entry.book.title, revision: entry.book.revision }, evidence: r.evidence.map(e => evidenceView(entry, e)),
      interpretationVerified: false, authorship: 'model-authored-full-book-review', materialCoverageMeans: 'offered-to-model-not-independent-comprehension' }); }
}

