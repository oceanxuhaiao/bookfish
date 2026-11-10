import { digest } from './books.ts';
import { SourceError, type SourceCatalog, type ChapterLink, type CachedChapter } from './source-types.ts';

/** Capabilities are declarations checked against probes, not inferred from HTTP 200. */
export interface SerialCapabilities {
  catalog: boolean;
  chapterContent: boolean;
  stableChapterId: boolean;
  chapterRevision: boolean;
  publicationStatus: boolean;
  cancellation: boolean;
  conditionalRequest: boolean;
  rateLimit: 'declared' | 'observed' | 'unknown';
}
export type SerialAuthorization = 'allowed' | 'unknown' | 'blocked';
export interface SerialPublicationEvidence { status: 'ongoing' | 'finished' | 'unknown'; source: string; observedAt: string; note: string }
export interface SerialSubscription {
  enabled: boolean;
  intervalMinutes: number;
  nextCheckAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessfulCheckAt: string | null;
  failures: number;
  backoffUntil: string | null;
}
export type SerialReceiptStatus = 'succeeded' | 'no_change' | 'failed' | 'cancelled' | 'conflict';
export interface SerialReceipt {
  jobId: string; at: string; status: SerialReceiptStatus;
  expectedVersion: number; committedVersion: number;
  baseCatalogHash: string; catalogHash: string;
  addedCount: number; addedChapterIds: string[];
  error: string | null;
}
export interface SerialLastCheck { at: string; status: SerialReceiptStatus; message: string }
export interface SerialRecord {
  serialId: string; editionEpoch: number; contentVersion: number; subscriptionRevision: number;
  sourceId: string; sourceBookId: string; bookUrl: string;
  capabilities: SerialCapabilities; authorization: SerialAuthorization; authorizationNote: string;
  publicationEvidence: SerialPublicationEvidence;
  subscription: SerialSubscription;
  receipts: SerialReceipt[];
  /** End segment id (exclusive) for each cached chapter, in catalog order. */
  layout: number[];
  lastCheck: SerialLastCheck | null;
}
export interface SerialIdentity { adapterId: string; sourceBookId: string; bookUrl: string; title: string; author: string }
export interface SerialChapter {
  id: string; title: string; url: string; revision: string | null;
  text: string; hash: string; pages: Array<{ url: string; hash: string }>; fetchedAt: string;
}
export interface SerialSourceAdapter {
  readonly id: string;
  readonly capabilities: SerialCapabilities;
  readonly authorization: SerialAuthorization;
  readonly authorizationNote: string;
  catalog(binding: { bookUrl: string; sourceBookId: string }, signal: AbortSignal): Promise<SourceCatalog>;
  chapter(binding: { bookUrl: string; sourceBookId: string }, chapter: ChapterLink, signal: AbortSignal): Promise<SerialChapter>;
}
export const SERIAL_INTERVALS = [30, 60, 180, 360] as const;
const ISO = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const int = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function chapterId(chapter: ChapterLink): string { return chapter.id ?? chapter.url; }
export function serialCatalogHash(catalog: Pick<SourceCatalog, 'adapter' | 'bookUrl' | 'title' | 'author' | 'publicationStatus' | 'chapters'>): string {
  return digest(JSON.stringify([catalog.adapter, catalog.bookUrl, catalog.title, catalog.author, catalog.publicationStatus,
    catalog.chapters.map((c) => [chapterId(c), c.title, c.url, c.revision ?? null])]));
}
export function stableSerialIdentity(serialId: string, editionEpoch: number) {
  const id = digest(`serial\n${serialId}`);
  const revision = digest(`serial-edition\n${serialId}\n${editionEpoch}`);
  return { id, revision, key: `${id}:${revision}` };
}
export function validateSerialCatalog(catalog: SourceCatalog, expected?: { bookUrl?: string; title?: string; author?: string }): void {
  if (!catalog || typeof catalog.adapter !== 'string' || !catalog.adapter || catalog.adapter.length > 80 ||
    typeof catalog.bookUrl !== 'string' || typeof catalog.title !== 'string' || !catalog.title.trim() || catalog.title.length > 200 ||
    typeof catalog.author !== 'string' || catalog.author.length > 100 || !int(catalog.declaredTotal, 1, 20000) ||
    !Array.isArray(catalog.chapters) || catalog.chapters.length !== catalog.declaredTotal ||
    !['finished', 'ongoing', 'unknown'].includes(catalog.publicationStatus) || !ISO(catalog.fetchedAt) ||
    catalog.complete === false || (catalog.pageCount !== undefined && !int(catalog.pageCount, 1, 100))) {
    throw new SourceError('invalid_content', 'Invalid serial catalog snapshot');
  }
  if (expected?.bookUrl !== undefined && catalog.bookUrl !== expected.bookUrl) throw new SourceError('invalid_content', 'Catalog book URL changed');
  if (expected?.title !== undefined && catalog.title !== expected.title) throw new SourceError('invalid_content', 'Catalog book title changed');
  if (expected?.author !== undefined && catalog.author !== expected.author) throw new SourceError('invalid_content', 'Catalog author changed');
  const ids = new Set<string>(), urls = new Set<string>();
  for (const chapter of catalog.chapters) {
    if (!chapter || !text(chapter.title, 200) || !text(chapter.url, 2000) || (chapter.id !== undefined && !text(chapter.id, 500)) ||
      (chapter.revision !== undefined && !text(chapter.revision, 200))) throw new SourceError('invalid_content', 'Invalid serial chapter identity');
    const id = chapterId(chapter);
    if (ids.has(id) || urls.has(chapter.url)) throw new SourceError('invalid_content', 'Catalog contains duplicate chapter identity');
    ids.add(id); urls.add(chapter.url);
  }
  if (catalog.hash !== serialCatalogHash(catalog)) throw new SourceError('invalid_content', 'Catalog hash does not match its contents');
}
export function validateSerialRecord(record: SerialRecord, cacheLength: number, totalSegments: number): void {
  if (!record || !/^[a-f0-9-]{36}$/.test(record.serialId) || !int(record.editionEpoch, 1, 1000) ||
    !int(record.contentVersion, 1, Number.MAX_SAFE_INTEGER) || !int(record.subscriptionRevision, 1, Number.MAX_SAFE_INTEGER) ||
    !text(record.sourceId, 100) || !text(record.sourceBookId, 500) || !text(record.bookUrl, 2000) ||
    !record.capabilities || typeof record.capabilities !== 'object' ||
    !['allowed', 'unknown', 'blocked'].includes(record.authorization) || typeof record.authorizationNote !== 'string' || record.authorizationNote.length > 500) {
    throw new Error('Invalid serial subscription record');
  }
  const c = record.capabilities;
  for (const key of ['catalog', 'chapterContent', 'stableChapterId', 'chapterRevision', 'publicationStatus', 'cancellation', 'conditionalRequest'] as const) if (typeof c[key] !== 'boolean') throw new Error('Invalid serial capability declaration');
  if (!['declared', 'observed', 'unknown'].includes(c.rateLimit)) throw new Error('Invalid serial rate-limit declaration');
  const e = record.publicationEvidence;
  if (!e || !['ongoing', 'finished', 'unknown'].includes(e.status) || !text(e.source, 200) || !ISO(e.observedAt) || typeof e.note !== 'string' || e.note.length > 500) throw new Error('Invalid serial publication evidence');
  const s = record.subscription;
  if (!s || typeof s.enabled !== 'boolean' || !SERIAL_INTERVALS.includes(s.intervalMinutes as typeof SERIAL_INTERVALS[number]) ||
    (s.nextCheckAt !== null && !ISO(s.nextCheckAt)) || (s.lastAttemptAt !== null && !ISO(s.lastAttemptAt)) ||
    (s.lastSuccessfulCheckAt !== null && !ISO(s.lastSuccessfulCheckAt)) || !int(s.failures, 0, 1000000) ||
    (s.backoffUntil !== null && !ISO(s.backoffUntil))) throw new Error('Invalid serial schedule record');
  if (!Array.isArray(record.receipts) || record.receipts.length > 100 || !Array.isArray(record.layout) || record.layout.length !== cacheLength) throw new Error('Invalid serial receipts or layout');
  for (const r of record.receipts) {
    if (!r || !/^[a-f0-9-]{36}$/.test(r.jobId) || !ISO(r.at) || !['succeeded', 'no_change', 'failed', 'cancelled', 'conflict'].includes(r.status) ||
      !int(r.expectedVersion, 0, Number.MAX_SAFE_INTEGER) || !int(r.committedVersion, 0, Number.MAX_SAFE_INTEGER) ||
      typeof r.baseCatalogHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.baseCatalogHash) || typeof r.catalogHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.catalogHash) ||
      !int(r.addedCount, 0, 1000) || !Array.isArray(r.addedChapterIds) || r.addedChapterIds.length !== r.addedCount ||
      r.addedChapterIds.some((id) => typeof id !== 'string' || !id || id.length > 500) || (r.error !== null && (typeof r.error !== 'string' || r.error.length > 500))) throw new Error('Invalid serial receipt');
  }
  let last = 0;
  for (const end of record.layout) { if (!int(end, last + 1, 1000000)) throw new Error('Invalid serial layout'); last = end; }
  if (cacheLength && last !== totalSegments) throw new Error('Serial layout does not cover cached text');
  if (!cacheLength && last !== 0) throw new Error('Empty serial cache has a layout');
  if (record.lastCheck && (!ISO(record.lastCheck.at) || !['succeeded', 'no_change', 'failed', 'cancelled', 'conflict'].includes(record.lastCheck.status) || typeof record.lastCheck.message !== 'string' || record.lastCheck.message.length > 500)) throw new Error('Invalid serial last-check record');
}
export type SerialCatalogDiff =
  | { kind: 'no_change' }
  | { kind: 'append'; appended: ChapterLink[] }
  | { kind: 'metadata_changed'; appended: ChapterLink[]; changedTitles: number; publicationChanged: boolean }
  | { kind: 'conflict'; reason: string; detail: string };
/** Strict prefix comparison; a growing tail is the only accepted content change. */
export function diffSerialCatalog(base: SourceCatalog, next: SourceCatalog): SerialCatalogDiff {
  validateSerialCatalog(base); validateSerialCatalog(next);
  if (next.adapter !== base.adapter || next.bookUrl !== base.bookUrl || next.title !== base.title || next.author !== base.author) {
    return { kind: 'conflict', reason: 'identity_changed', detail: '来源、URL、书名或作者与已接受快照不一致' };
  }
  if (next.chapters.length < base.chapters.length) return { kind: 'conflict', reason: 'catalog_shrunk', detail: '新目录比已接受目录更短，不能当作没有更新' };
  let changedTitles = 0;
  for (let i = 0; i < base.chapters.length; i++) {
    const a = base.chapters[i], b = next.chapters[i];
    if (chapterId(a) !== chapterId(b)) return { kind: 'conflict', reason: 'chapter_identity_changed', detail: `第 ${i + 1} 章 ID 或 URL 发生变化` };
    if (a.url !== b.url) return { kind: 'conflict', reason: 'chapter_url_changed', detail: `第 ${i + 1} 章 URL 发生变化` };
    if ((a.revision ?? null) !== (b.revision ?? null)) return { kind: 'conflict', reason: 'source_revision_detected', detail: `第 ${i + 1} 章来源修订标记发生变化` };
    if (a.title !== b.title) changedTitles++;
  }
  const appended = next.chapters.slice(base.chapters.length).map((c) => ({ ...c }));
  const publicationChanged = next.publicationStatus !== base.publicationStatus;
  if (changedTitles) return { kind: 'metadata_changed', appended, changedTitles, publicationChanged };
  if (appended.length) return { kind: 'append', appended };
  if (publicationChanged) return { kind: 'metadata_changed', appended, changedTitles: 0, publicationChanged };
  return { kind: 'no_change' };
}
export function nextCheckIso(now: number, minutes: number): string { return new Date(now + minutes * 60000).toISOString(); }
export function newSerialRecord(input: { serialId: string; adapterId: string; sourceBookId: string; bookUrl: string;
  capabilities: SerialCapabilities; authorization: SerialAuthorization; authorizationNote: string; catalog: Pick<SourceCatalog, 'publicationStatus' | 'fetchedAt'>;
  enabled: boolean; intervalMinutes: number; now: number }): SerialRecord {
  return { serialId: input.serialId, editionEpoch: 1, contentVersion: 1, subscriptionRevision: 1,
    sourceId: input.adapterId, sourceBookId: input.sourceBookId, bookUrl: input.bookUrl,
    capabilities: { ...input.capabilities }, authorization: input.authorization, authorizationNote: input.authorizationNote,
    publicationEvidence: { status: input.catalog.publicationStatus, source: input.adapterId, observedAt: input.catalog.fetchedAt,
      note: input.authorization === 'unknown' ? '来源用途授权未确认；只保存本机阅读缓存。' : '' },
    subscription: { enabled: input.enabled, intervalMinutes: input.intervalMinutes,
      nextCheckAt: input.enabled ? nextCheckIso(input.now, input.intervalMinutes) : null,
      lastAttemptAt: null, lastSuccessfulCheckAt: null, failures: 0, backoffUntil: null },
    receipts: [], layout: [], lastCheck: null };
}
export function receiptFor(input: { jobId: string; at: string; status: SerialReceiptStatus; expectedVersion: number; committedVersion: number; baseCatalogHash: string; catalogHash: string; addedChapterIds: string[]; error: string | null }): SerialReceipt {
  return { ...input, addedCount: input.addedChapterIds.length };
}
export const SERIAL_PAGE_LIMIT = 20;
export const SERIAL_BATCH_BYTES = 5 * 1024 * 1024;
export function cachedChapterFromSerial(chapter: SerialChapter, index: number): CachedChapter {
  return { index, text: chapter.text, hash: chapter.hash, fetchedAt: chapter.fetchedAt, pages: chapter.pages.map((p) => ({ url: p.url, hash: p.hash })) };
}
export interface SerialSyncCommit {
  bookKey: string;
  expectedSubscriptionRevision: number;
  expectedContentVersion: number;
  baseCatalogHash: string;
  catalog: SourceCatalog;
  /** New complete chapters only, starting at the accepted cache length. */
  chapters: CachedChapter[];
  publicationEvidence: SerialPublicationEvidence;
  receipt: { jobId: string; status: SerialReceiptStatus; error: string | null };
  /** Backoff target when the committed prefix is incomplete (failed body fetch). */
  retryAt?: string | null;
}
export interface SerialCatalogCommit {
  bookKey: string;
  expectedSubscriptionRevision: number;
  expectedContentVersion: number;
  baseCatalogHash: string;
  catalog: SourceCatalog;
  publicationEvidence: SerialPublicationEvidence;
  receipt: { jobId: string; status: SerialReceiptStatus; error: string | null };
}
