import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, copyFileSync, readdirSync, lstatSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HistoryStore, historyFork, historySelect, historyFind, historyPage, historyCount, isHistory, plainHistory, type HistoryRef } from './history.ts';
import { BookStorage } from './book-storage.ts';
import { isPagedBook, chapterSpan, chapterEndIds, remoteLayout, readerChapters } from './paged-book.ts';
import { buildBook, decodeFile, digest, requiredText, type Book } from './books.ts';
import { searchReading, readingContext } from './retrieval.ts';
import { beginReview, reviewMaterials, finishReview, failReview, validateReviews, type BookReview, type ReviewJob } from './reviews.ts';
import { normalizeEpisode, validateEpisodes, evidenceView, record, MAX_EPISODES, type ReadingEpisode } from './journal.ts';
import { buildRemoteBook, buildSerialBook } from './remote-books.ts';
import { SourceError, type CachedChapter, type SourceCatalog } from './source-types.ts';
import { SERIAL_INTERVALS, SERIAL_PAGE_LIMIT, chapterId, nextCheckIso, receiptFor, stableSerialIdentity, validateSerialCatalog, validateSerialRecord, type SerialCatalogCommit, type SerialPublicationEvidence, type SerialReceipt, type SerialRecord, type SerialSyncCommit } from './serial-types.ts';
import { emptySelection, validateSelection, type SelectionState } from './selection-types.ts';

const MAX_STATE_BYTES = 128 * 1024 * 1024;
const MAX_LIBRARY_CHARS = 128 * 1024 * 1024;
const LEASE_MS = 10 * 60 * 1000;
export interface Receipt { taskId: string; bookKey: string; segmentId: number; frontier: number; confirmedChars: number; understanding: string; confirmedAt?: number; episodeId?: string }
export interface ReadingTask {
  id: string; bookKey: string; segmentId: number; generation: number; expiresAt: number;
  status: 'pending' | 'committed' | 'cancelled' | 'expired'; receipt?: Receipt;
}
export interface BookEntry { book: Book; frontier: number; serial?: SerialRecord }
export interface RestRecord {id:string;bookKey:string;startedAt:number;plannedUntil:number;endedAt:number|null;state:'scheduled'|'ended'|'interrupted'|'skipped';source:'session'|'model';readingMs:number}
export interface LibraryState {
  schema: 3; generation: number; selected: string | null; paused: boolean;
  books: BookEntry[]; tasks: ReadingTask[]; episodes: ReadingEpisode[]; nextEpisodeSequence: number;
  reviewJobs: ReviewJob[]; reviews: BookReview[]; rests?:RestRecord[];
  /** External wishes and their mechanical acquisition/queue state. Never Persona Memory. */
  selection: SelectionState;
}
function empty(): LibraryState { return { schema: 3, generation: 0, selected: null, paused: false, books: [], tasks: [], episodes: [], nextEpisodeSequence: 1, reviewJobs: [], reviews: [],rests:[],selection:emptySelection() }; }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
const serialOf = (book: Book) => book.remote?.serial;
export type SerialReadiness = 'backlog' | 'waiting_content' | 'caught_up' | 'finished' | 'conflict';
function serialSummary(book: Book, frontier: number, serial = serialOf(book)) {
  if (!serial || !book.remote) return null;
  const catalog = book.remote.catalog, cached = book.remote.cache.length, total = catalog.chapters.length;
  let confirmedChapters = 0;
  while (confirmedChapters < cached && serial.layout[confirmedChapters] <= frontier) confirmedChapters++;
  let readiness: SerialReadiness;
  if (serial.lastCheck?.status === 'conflict') readiness = 'conflict';
  else if (frontier < book.segments.length) readiness = 'backlog';
  else if (cached < total) readiness = 'waiting_content';
  else if (catalog.publicationStatus === 'finished') readiness = 'finished';
  else readiness = 'caught_up';
  return { serial, catalog, cached, total, confirmedChapters, readiness, complete: readiness === 'finished' };
}

/** Rebuild indexes from source and verify progress against unique committed ranges before trusting a snapshot. */
export function validateState(raw: unknown): LibraryState {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid library state');
  const state = raw as LibraryState;
  const schema = (raw as { schema?: unknown }).schema;
  if (schema === 1 && ('episodes' in state || 'nextEpisodeSequence' in state)) throw new Error('Legacy schema cannot contain a new-format journal');
  if (schema !== 3 && ('reviews' in state || 'reviewJobs' in state)) throw new Error('Legacy schema cannot contain review records');
  if ((schema !== 1 && schema !== 2 && schema !== 3) || !integer(state.generation) || typeof state.paused !== 'boolean' ||
    !Array.isArray(state.books) || state.books.length > 100 || !Array.isArray(state.tasks) || state.tasks.length > 250000) throw new Error('Unsupported or invalid library state');
  const books = new Map<string, BookEntry>();
  for (const entry of state.books) {
    if (!entry?.book || (!isPagedBook(entry.book) && typeof entry.book.text !== 'string') || !integer(entry.frontier)) throw new Error('Invalid book entry');
    const original = entry.book;
    if(isPagedBook(original)){
      const serial=entry.serial??serialOf(original);
      if(serial){const identity=stableSerialIdentity(serial.serialId,serial.editionEpoch);if(original.key!==identity.key||original.id!==identity.id||original.revision!==identity.revision)throw new Error('Serial book identity does not match its record');validateSerialRecord(serial,original.remote!.cache.length,original.segments.length);}
      if(entry.frontier>original.segments.length||books.has(original.key))throw Error('Invalid paged book progress');books.set(original.key,{book:original,frontier:entry.frontier,...(entry.serial?{serial:entry.serial}:{})});continue;
    }
    const rebuilt = original.remote ? buildRemoteBook(original.remote) : buildBook(original.filename, original.title, original.author, original.text);
    if (original.key !== rebuilt.key || original.id !== rebuilt.id || original.revision !== rebuilt.revision ||
      original.text !== rebuilt.text || original.sourceHash !== rebuilt.sourceHash || original.parserVersion !== rebuilt.parserVersion || original.totalChars !== rebuilt.totalChars ||
      (!Array.isArray(original.segments)||original.segments.length!==rebuilt.segments.length||original.segments.some((s,i)=>!s||Object.keys(s).length!==5||s.id!==rebuilt.segments[i].id||s.chapter!==rebuilt.segments[i].chapter||s.start!==rebuilt.segments[i].start||s.end!==rebuilt.segments[i].end||s.text!==rebuilt.segments[i].text)) || entry.frontier > rebuilt.segments.length || books.has(original.key)) throw new Error('Book content or index is inconsistent');
    books.set(original.key, { book: rebuilt, frontier: entry.frontier, ...(entry.serial ? { serial: entry.serial } : {}) });
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
    if (ranges.size !== entry.frontier || [...ranges].some((i) => i >= entry.frontier)) throw new Error('Progress is not a continuous confirmed range');
  }
  const episodes = validateEpisodes(schema === 1 ? [] : state.episodes, books, state.tasks);
  const nextEpisodeSequence = schema === 1 ? 1 : state.nextEpisodeSequence;
  if (!Number.isSafeInteger(nextEpisodeSequence) || nextEpisodeSequence < 1 || nextEpisodeSequence <= (episodes.at(-1)?.sequence ?? 0)) throw new Error('Invalid episode sequence counter');
  const result: LibraryState = { schema: 3, episodes, nextEpisodeSequence, reviewJobs: schema === 3 ? state.reviewJobs : [], reviews: schema === 3 ? state.reviews : [], generation: state.generation, selected: state.selected, paused: state.paused,
    selection: validateSelection((raw as { selection?: unknown }).selection),
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
  validateReviews(result); return result;
}

export interface LibraryOptions {
  dataDir: string;
  /** Absolute directory for full book text; empty keeps dataDir/bookfish/books. */
  textStoreDir?: string;
  now?: () => number;
  /** Tests may inject a failing disk commit; live instances always use atomicWrite. */
  write?: (file: string, state: LibraryState) => void;
  beforeMetadataCommit?:()=>void;
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
  private historyRef?:HistoryRef;
  private characterCache=new Map<string,{characters:Array<{name:string;aliases:string[];episodeIds:string[];aliasesTruncated:boolean;episodeLinksTruncated:boolean}>;truncated:boolean}>();
  private lockToken: string | undefined;
  private textStoreError: string | null = null;
  private textStoreMoved = 0;
  private readonly now: () => number;
  constructor(private readonly options: LibraryOptions) {
    this.dir = join(options.dataDir, 'bookfish'); this.file = join(this.dir, 'library.json');
    this.now = options.now ?? Date.now; this.bookStorage = new BookStorage(this.dir, options.textStoreDir);this.history=new HistoryStore(join(this.dir,'history.sqlite'));
  }
  private acquire(): void {
    const file = join(this.dir, 'writer.lock');
    if (existsSync(file)) {
      let pid: number;
      try { pid = JSON.parse(readFileSync(file, 'utf8')).pid; }
      catch { throw new Error('Bookfish writer lock is invalid; inspect it before recovery'); }
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid lock owner');
      try { process.kill(pid, 0); throw new Error('Bookfish library is already open'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      unlinkSync(file);
    }
    const token = randomUUID();
    const fd = openSync(file, 'wx');
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); }
    finally { closeSync(fd); }
    this.lockToken = token;
  }
  open(): void {
    if (this.opened) return;
    mkdirSync(this.dir, { recursive: true });
    this.acquire();
    try {
      try { const moved=this.bookStorage.prepareTextStore(this.options.textStoreDir ?? '', join(this.dir,'books')); this.textStoreError=null; this.textStoreMoved=moved.moved; }
      catch (error) { this.textStoreError=String(error); this.bookStorage.fallbackToDefault(join(this.dir,'books')); }
      this.history.open();
      if (existsSync(this.file)) {
        if (statSync(this.file).size > MAX_STATE_BYTES) throw new Error('Library state is too large');
        const raw=JSON.parse(readFileSync(this.file, 'utf8'));
        if(![5,6,7].includes(raw.schema)&&!existsSync(this.file+'.before-paged'))copyFileSync(this.file,this.file+'.before-paged');
        if(raw.schema!==6&&raw.schema!==7&&!existsSync(this.file+'.before-history')){copyFileSync(this.file,this.file+'.before-history');this.bookStorage.protectRollback(raw);}
        const hydrated=this.bookStorage.hydrate(raw) as LibraryState;if(raw.schema===6||raw.schema===7){this.historyRef=raw.$history;this.state=validateState(this.history.hydrate(hydrated,raw.$history));}else this.state=validateState(hydrated);
        if(!raw.books.some((e:{book:{$bookBlob?:unknown}})=>e.book?.$bookBlob)&&!existsSync(this.file+'.before-split-v3'))copyFileSync(this.file,this.file+'.before-split-v3');
      }
      this.recoverTemporary();
      this.opened = true;
      this.change((draft) => this.invalidate(draft));
    } catch (error) { this.close(); throw error; }
  }
  private recoverTemporary(){
    // Writer lock is held and the committed snapshot has passed validation.
    const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
    const patterns=[{dir:this.dir,re:new RegExp('^(?:library\\.json\\.'+uuid+'\\.tmp|'+uuid+'\\.history-(?:backup|restore)\\.sqlite)$')},{dir:this.bookStorage.dir,re:new RegExp('^(?:'+uuid+'(?:\\.canonical)?\\.tmp|[a-f0-9]{64}\\.json\\.gz\\.'+uuid+'\\.tmp)$')}];
    for(const {dir,re}of patterns)if(existsSync(dir))for(const name of readdirSync(dir)){if(re.test(name)){const file=join(dir,name),st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw Error('Unexpected temporary path');unlinkSync(file);}}
  }
  close(): void {
    const file = join(this.dir, 'writer.lock');
    if (this.lockToken && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.token === this.lockToken) unlinkSync(file);
    }
    this.lockToken = undefined; this.opened = false; this.state = empty(); this.bookStorage.clearCache();this.history.close();this.historyRef=undefined;this.goalCache=undefined;this.characterCache.clear();
  }
  storageStats(){return {...this.bookStorage.cache.stats(),history:this.history.stats(),textStore:this.textStoreStatus()};}
  textStoreStatus(){return {dir:this.bookStorage.dir,defaultDir:join(this.dir,'books'),configured:this.options.textStoreDir??'',error:this.textStoreError,moved:this.textStoreMoved};}
  private ensureOpen(): void { if (!this.opened) throw new Error('Bookfish library is not mounted'); }
  private change<T>(action: (draft: LibraryState) => T): T {
    this.ensureOpen();
    const draft = { ...structuredClone({ ...this.state, books: [],tasks:[],episodes:[] }), tasks:historyFork(this.state.tasks),episodes:historyFork(this.state.episodes),books: this.state.books.map(e=>({ book:e.book, frontier:e.frontier, ...(e.serial?{serial:e.serial}:{}) })) };
    const result = action(draft);
    if(this.options.write)this.options.write(this.file,draft);else {const ref=this.history.prepare(draft,this.historyRef);this.options.beforeMetadataCommit?.();atomicWrite(this.file,{...this.bookStorage.prepare(draft) as LibraryState,schema:draft.books.some(e=>e.book.remote?.serial)?7:6,tasks:[],episodes:[],$history:ref} as unknown as LibraryState);this.historyRef=ref;this.state=this.history.bind(draft,ref);this.history.committed(ref);}
    if(this.options.write)this.state = draft;
    if(!this.options.write)this.bookStorage.collect(draft);
    this.goalCache=undefined;return structuredClone(plainHistory(result));
  }
  private invalidate(draft: LibraryState): void {
    draft.generation++;
    for (const task of historySelect(draft.tasks,{status:'pending'})) if (task.status === 'pending') task.status = 'cancelled';
    for (const job of draft.reviewJobs) if (job.status === 'pending') { job.status = 'cancelled'; job.error = 'Library remounted, paused or revision changed; retry explicitly with a new requestId'; }
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
  private view(entry: BookEntry) {
    const b = entry.book;
    const serial = serialSummary(b, entry.frontier, entry.serial);
    const confirmedChars = entry.frontier ? b.segments[entry.frontier - 1].end : 0;
    const loaded = b.remote?.cache.length ?? 0;
    let completedChapters = serial?.confirmedChapters ?? 0;
    const layout=remoteLayout(b);if(layout&&!serial)completedChapters=layout.ends.filter(end=>end<=entry.frontier).length;
    if (b.remote&&!layout&&!serial) {
      let segmentCount = 0;
      for (const chapter of b.remote.cache) {
        segmentCount += Math.ceil(Array.from(`# ${b.remote.catalog.chapters[chapter.index].title}\n${chapter.text}\n\n`).length / 1200);
        if (entry.frontier >= segmentCount) completedChapters++;
      }
    }
    const chapterIndex = Math.max(0, entry.frontier-1); let lo=chapterIndex, hi=chapterIndex;
    const span=chapterSpan(b,chapterIndex);if(span){lo=span.first;hi=span.last;}
    while(!span && lo>0 && b.segments[lo-1].chapter===b.segments[chapterIndex].chapter)lo--;
    while(!span && hi+1<b.segments.length && b.segments[hi+1].chapter===b.segments[chapterIndex].chapter)hi++;
    const chapterProgress=entry.frontier && b.segments.length ? (confirmedChars-b.segments[lo].start)/(b.segments[hi].end-b.segments[lo].start) : 0;
    const totalChapters=serial?.total ?? (b.remote?b.remote.catalog.chapters.length:0);
    return { chapterProgress, key: b.key, id: b.id, revision: b.revision, title: b.title, author: b.author,
      identifiedChapters:serial?serial.total:b.remote?b.remote.catalog.chapters.length:chapterEndIds(b).size,chapterGoalSupported:!!b.remote||chapterEndIds(b).size>0,
      totalChars: b.totalChars, totalSegments: b.segments.length, confirmedSegments: entry.frontier,
      confirmedChars, progress: serial ? (serial.total ? serial.confirmedChapters / serial.total : 0) : b.remote ? completedChapters / b.remote.catalog.chapters.length : confirmedChars / b.totalChars,
      progressUnit: b.remote ? 'chapters' as const : 'characters' as const,
      chapter: entry.frontier ? b.segments[entry.frontier - 1].chapter : '尚未开始',
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
      textStore: this.textStoreStatus() };
  }
  import(input: unknown) { return this.addBook(decodeFile(input)); }
  importBytes(metadata: {filename:unknown;title:unknown;author?:unknown}, bytes:Uint8Array) { return this.addBook(buildBook(metadata.filename,metadata.title,metadata.author,bytes)); }
  importFile(metadata:{filename:unknown;title:unknown;author?:unknown},file:string){
    this.ensureOpen();try{return this.addBook(this.bookStorage.importFile(file,metadata));}finally{this.bookStorage.collect(this.state);}
  }
  adoptValidatedImport(file:string,id:string,receipt:{size:number;mtimeMs:number}){
    this.ensureOpen();try{return this.addBook(this.bookStorage.adoptValidatedImport(file,id,receipt));}finally{this.bookStorage.collect(this.state);}
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
  selection(): SelectionState { this.ensureOpen(); return structuredClone(this.state.selection); }
  /** The single writable path for autonomous-selection records; it participates in the same atomic snapshot. */
  updateSelection<T>(action: (draft: SelectionState) => T): T {
    return this.change((draft) => { const result = action(draft.selection); draft.selection.generation++; return result; });
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
        const retryContent = input.episode === undefined ? undefined : normalizeEpisode(input.episode, entry, (saved?historySelect(draft.episodes,{before:saved.sequence}):draft.episodes), task.segmentId + 1);
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
      const content = normalizeEpisode(input.episode, entry, draft.episodes, entry.frontier + 1);
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
      const content = normalizeEpisode(input.episode, entry, existing ? historySelect(draft.episodes,{before:existing.sequence}) : draft.episodes);
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
    return structuredClone({ bookKey, total, confirmedRanges: entry.frontier, rangesWithoutReadingEpisode: entry.frontier - noted,
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
  reread(key: unknown, index: unknown) {
    this.ensureOpen();
    const entry = this.state.books.find((e) => e.book.key === key);
    if (!entry || !integer(index) || index >= entry.frontier) throw new Error('Only confirmed segments may be recalled');
    return { bookKey: entry.book.key, segment: structuredClone(entry.book.segments[index]), progressAdvanced: false, source: 'external-book-text' };
  }
  remove(key: unknown) {
    return this.change((draft) => {
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
  }
  writeArchive(file:string) {
    this.ensureOpen();if(this.options.write)return this.bookStorage.writeArchive(file,this.state);
    const snapshot=join(this.dir,randomUUID()+'.history-backup.sqlite');try{this.history.snapshot(snapshot);return this.bookStorage.writeArchive(file,this.state,{file:snapshot,ref:this.historyRef!});}finally{if(existsSync(snapshot))unlinkSync(snapshot);}
  }
  restoreArchive(file:string) {
    this.ensureOpen();if(this.state.books.length)throw Error('Restore requires an empty library');let installed=false;
    try{
      const result=this.bookStorage.readArchive(file,(database,ref,raw)=>{
        const source=new HistoryStore(database,true);try{source.open();const restored=validateState(source.hydrate(raw,ref as HistoryRef));this.change(draft=>{Object.assign(draft,restored,{tasks:historyFork(restored.tasks),episodes:historyFork(restored.episodes)});this.invalidate(draft);this.pauseSerialAfterRestore(draft);});installed=true;return this.state;}finally{source.close();}
      }) as LibraryState;
      if(!installed){const restored=validateState(result);this.change(draft=>{Object.assign(draft,restored,{tasks:historyFork(restored.tasks),episodes:historyFork(restored.episodes)});this.invalidate(draft);this.pauseSerialAfterRestore(draft);});}
      return {restoredBooks:this.state.books.length};
    }catch(error){this.bookStorage.collect(this.state);throw error;}
  }
  export() {
    this.ensureOpen();
    if(this.state.books.reduce((n,e)=>n+e.book.totalChars,0)>4*1024*1024)throw new Error('Use the chunked .bfbak backup for large libraries');
    if(this.state.tasks.length+this.state.episodes.length>10000)throw Error('Use .bfbak for large reading histories');
    const payload = JSON.stringify(this.state);
    return JSON.stringify({ format: 'bookfish-backup-v1', checksum: digest(payload), payload });
  }
  clear() {
    return this.change((draft) => {
      this.invalidate(draft); draft.books = []; draft.tasks = []; draft.episodes = []; draft.selected = null; draft.reviews = []; draft.reviewJobs = []; draft.selection = emptySelection();
      return 'Bookfish books and progress cleared';
    });
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

