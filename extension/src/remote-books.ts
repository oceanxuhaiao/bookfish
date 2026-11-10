import { digest, MAX_BOOK_BYTES, SEGMENT_CHARS, type Book, type Segment } from './books.ts';
import { catalogHash, catalogUrl } from './biquge.ts';
import { sourceUrl } from './source-http.ts';
import { SourceError, type RemoteSource, type CachedChapter, type ChapterLink } from './source-types.ts';
import { chapterId, stableSerialIdentity, validateSerialCatalog, validateSerialRecord, type SerialRecord } from './serial-types.ts';

export function serialContentHash(hashes: readonly string[]): string {
  let hash = digest('serial-content-v1');
  for (const chapterHash of hashes) hash = digest(`${hash}\n${chapterHash}`);
  return hash;
}
function chapterSegments(chapter: ChapterLink, entry: CachedChapter, firstId: number, offset: number): Segment[] {
  // A fixed trailing separator keeps every previous segment byte-identical when a chapter is appended.
  const chapterText = `# ${chapter.title}\n${entry.text}\n\n`;
  const chars = Array.from(chapterText);
  const segments: Segment[] = [];
  for (let from = 0; from < chars.length; from += SEGMENT_CHARS) {
    const part = chars.slice(from, from + SEGMENT_CHARS).join('');
    const length = Math.min(SEGMENT_CHARS, chars.length - from);
    segments.push({ id: firstId + segments.length, chapter: chapter.title, start: offset, end: offset + length, text: part });
    offset += length;
  }
  return segments;
}
function validateCachedChapter(entry: CachedChapter, index: number, catalogLen: number): void {
  if (entry.index !== index || typeof entry.text !== 'string' || entry.text.length < 30 || Buffer.byteLength(entry.text) > 256 * 1024 ||
    entry.hash !== digest(entry.text) || typeof entry.fetchedAt !== 'string' || !Number.isFinite(Date.parse(entry.fetchedAt)) ||
    !Array.isArray(entry.pages) || !entry.pages.length || entry.pages.length > 12 || index >= catalogLen) {
    throw new SourceError('invalid_content', 'Serial cache is not a contiguous, valid chapter prefix');
  }
  const urls = new Set<string>();
  for (const page of entry.pages) {
    if (!page || typeof page.url !== 'string' || !page.url || page.url.length > 2000 || urls.has(page.url) || !/^[0-9a-f]{64}$/.test(page.hash)) {
      throw new SourceError('invalid_content', 'Invalid serial page provenance');
    }
    urls.add(page.url);
  }
  if (entry.pages[0].url !== entry.pages[0].url.trim()) throw new SourceError('invalid_content', 'Invalid serial page URL');
}
function concatSegments(base: Segment[], appended: Segment[]): Segment[] {
  return new Proxy([] as Segment[], {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) {
        const index = Number(key);
        if (index < base.length) return base[index];
        return appended[index - base.length];
      }
      if (key === 'length') return base.length + appended.length;
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) return Number(key) < base.length + appended.length;
      return Reflect.has(target, key);
    },
    set() { throw new Error('Book segments are immutable'); },
  });
}
function attachText(book: Book, segments: Segment[]): void {
  let cached: string | undefined;
  Object.defineProperty(book, 'text', { enumerable: true, configurable: false, get() {
    if (cached === undefined) { let text = ''; for (const segment of segments) text += segment.text; cached = text; }
    return cached;
  } });
}

/** Build or extend a serial book without touching accepted segments. A base must be an exact prefix. */
export function buildSerialBook(input: RemoteSource & { serial: SerialRecord }, base?: Book): Book {
  const { catalog, serial } = input;
  validateSerialCatalog(catalog, { bookUrl: serial.bookUrl });
  if (!Array.isArray(input.cache) || input.cache.length > catalog.chapters.length || input.cache.length > 20000) throw new SourceError('invalid_content', 'Invalid serial cache length');
  for (let i = 0; i < input.cache.length; i++) validateCachedChapter(input.cache[i], i, catalog.chapters.length);
  const identity = stableSerialIdentity(serial.serialId, serial.editionEpoch);
  if (base) {
    if (!base.remote?.serial || base.key !== identity.key || base.remote.serial.serialId !== serial.serialId ||
      base.remote.serial.editionEpoch !== serial.editionEpoch || base.remote.cache.length > input.cache.length ||
      base.remote.catalog.chapters.length > catalog.chapters.length) throw new SourceError('invalid_content', 'Serial append base is not the accepted edition');
    for (let i = 0; i < base.remote.catalog.chapters.length; i++) {
      const a = base.remote.catalog.chapters[i], b = catalog.chapters[i];
      if (chapterId(a) !== chapterId(b) || a.title !== b.title || a.url !== b.url || (a.revision ?? null) !== (b.revision ?? null)) {
        throw new SourceError('invalid_content', 'Serial catalog is not a strict append of the accepted snapshot');
      }
    }
    for (let i = 0; i < base.remote.cache.length; i++) if (base.remote.cache[i].hash !== input.cache[i].hash) throw new SourceError('invalid_content', 'Serial chapter prefix hash changed');
    const baseEnd = base.remote.cache.length ? base.remote.serial.layout[base.remote.cache.length - 1] : 0;
    if (base.segments.length !== baseEnd) throw new SourceError('invalid_content', 'Serial layout does not match the accepted book');
  }
  const startIndex = base?.remote?.cache.length ?? 0;
  const startSegments = base?.segments ?? [];
  const startChars = base?.totalChars ?? 0;
  const appended: Segment[] = [];
  const appendedEnds: number[] = [];
  let offset = startChars;
  for (let i = startIndex; i < input.cache.length; i++) {
    const parts = chapterSegments(catalog.chapters[i], input.cache[i], startSegments.length + appended.length, offset);
    appended.push(...parts);
    offset += parts.reduce((n, s) => n + (s.end - s.start), 0);
    appendedEnds.push(startSegments.length + appended.length);
  }
  if (offset > MAX_BOOK_BYTES) throw new SourceError('limit', 'Cached novel exceeds the current 100 MiB per-book limit; no text or progress was discarded');
  const segments = base ? concatSegments(startSegments, appended) : appended;
  const cache = base ? [...base.remote!.cache, ...input.cache.slice(startIndex).map((c, i) => ({ ...c, index: startIndex + i }))] : input.cache.map((c) => ({ ...c }));
  const layout = base ? [...base.remote!.serial!.layout, ...appendedEnds] : appendedEnds;
  const sourceHash = serialContentHash(cache.map((c) => c.hash));
  const record: SerialRecord = { ...serial, layout };
  validateSerialRecord(record, cache.length, segments.length);
  const remote: RemoteSource = {
    catalog: { ...catalog, chapters: catalog.chapters.map((c) => ({ ...c })) },
    cache,
    serial: record,
  };
  if (input.lastError) {
    const e = input.lastError;
    if (!['unsupported', 'needs_login', 'restricted', 'missing', 'temporary', 'invalid_content', 'limit', 'cancelled'].includes(e.code) || typeof e.message !== 'string' || e.message.length > 500 || !Number.isFinite(Date.parse(e.at)) || e.chapterIndex !== cache.length) throw new SourceError('invalid_content', 'Invalid source error record');
    remote.lastError = { code: e.code, message: e.message, at: e.at, chapterIndex: e.chapterIndex };
  }
  const book: Book = { key: identity.key, id: identity.id, revision: identity.revision, title: catalog.title, author: catalog.author,
    filename: 'remote.md', text: '', sourceHash, totalChars: offset, parserVersion: 1, segments, remote };
  attachText(book, segments);
  return book;
}

export function buildRemoteBook(input: RemoteSource): Book {
  if (input?.serial) return buildSerialBook(input as RemoteSource & { serial: SerialRecord });
  const catalog = input?.catalog;
  if (!catalog || catalog.adapter !== 'biquge-02345-v1' || typeof catalog.bookUrl !== 'string' || catalogUrl(catalog.bookUrl) !== catalog.bookUrl ||
      typeof catalog.title !== 'string' || !catalog.title.trim() || catalog.title.length > 200 || typeof catalog.author !== 'string' || !catalog.author.trim() || catalog.author.length > 100 ||
      !Number.isInteger(catalog.declaredTotal) || catalog.declaredTotal < 1 || catalog.declaredTotal > 5000 || !Array.isArray(catalog.chapters) || catalog.chapters.length !== catalog.declaredTotal ||
      typeof catalog.fetchedAt !== 'string' || !Number.isFinite(Date.parse(catalog.fetchedAt))) throw new SourceError('invalid_content', 'Invalid remote catalog snapshot');
  if (!['finished', 'ongoing', 'unknown'].includes(catalog.publicationStatus)) throw new SourceError('invalid_content', 'Missing source publication status');
  const urls = new Set<string>();
  for (const chapter of catalog.chapters) {
    if (!chapter || typeof chapter.title !== 'string' || !chapter.title.trim() || chapter.title.length > 200 || typeof chapter.url !== 'string' ||
        sourceUrl(chapter.url).origin !== sourceUrl(catalog.bookUrl).origin || !/^\d+\/$/.test(new URL(chapter.url).pathname.slice(new URL(catalog.bookUrl).pathname.length)) ||
        !chapter.url.startsWith(catalog.bookUrl) || urls.has(chapter.url)) throw new SourceError('invalid_content', 'Invalid remote chapter URL or identity');
    urls.add(chapter.url);
  }
  if (catalog.hash !== catalogHash(catalog) || !Array.isArray(input.cache) || input.cache.length > catalog.chapters.length) throw new SourceError('invalid_content', 'Catalog hash or cache length does not match');
  const segments: Segment[] = []; let text = ''; let offset = 0;
  const cache = input.cache.map((entry, index) => {
    if (entry.index !== index || typeof entry.text !== 'string' || entry.text.length < 30 || Buffer.byteLength(entry.text) > 256 * 1024 ||
        entry.hash !== digest(entry.text) || typeof entry.fetchedAt !== 'string' || !Number.isFinite(Date.parse(entry.fetchedAt)) ||
        !Array.isArray(entry.pages) || !entry.pages.length || entry.pages.length > 12) throw new SourceError('invalid_content', 'Remote cache is not a contiguous, valid chapter prefix');
    const chapter = catalog.chapters[index];
    for (let page = 0; page < entry.pages.length; page++) {
      const expected = page === 0 ? chapter.url : chapter.url.replace(/\/$/, `_${page + 1}/`);
      if (entry.pages[page].url !== expected || !/^[0-9a-f]{64}$/.test(entry.pages[page].hash)) throw new SourceError('invalid_content', 'Invalid cached page provenance');
    }
    // A fixed trailing separator makes prior segment bytes immutable when another chapter is appended.
    const chapterText = `# ${chapter.title}\n${entry.text}\n\n`;
    const chars = Array.from(chapterText);
    for (let from = 0; from < chars.length; from += SEGMENT_CHARS) {
      const part = chars.slice(from, from + SEGMENT_CHARS).join('');
      const length = Math.min(SEGMENT_CHARS, chars.length - from);
      segments.push({ id: segments.length, chapter: chapter.title, start: offset, end: offset + length, text: part }); offset += length;
    }
    text += chapterText;
    return { index, text: entry.text, hash: entry.hash, fetchedAt: entry.fetchedAt, pages: entry.pages.map(p => ({ url: p.url, hash: p.hash })) };
  });
  if (Buffer.byteLength(text) > MAX_BOOK_BYTES) throw new SourceError('limit', 'Cached novel exceeds the current 100 MiB per-book limit; no text or progress was discarded');
  const id = digest(`remote\n${catalog.bookUrl}\n${catalog.title}\n${catalog.author}`);
  const revision = digest(`remote-v1\n${catalog.hash}`);
  const remote: RemoteSource = { catalog: { adapter: catalog.adapter, bookUrl: catalog.bookUrl, title: catalog.title, author: catalog.author,
    declaredTotal: catalog.declaredTotal, publicationStatus: catalog.publicationStatus,
    chapters: catalog.chapters.map(c => ({ title: c.title, url: c.url })), fetchedAt: catalog.fetchedAt, hash: catalog.hash }, cache };
  if (input.lastError) {
    const e = input.lastError;
    if (!['unsupported', 'needs_login', 'restricted', 'missing', 'temporary', 'invalid_content', 'limit', 'cancelled'].includes(e.code) || typeof e.message !== 'string' || e.message.length > 500 || !Number.isFinite(Date.parse(e.at)) || e.chapterIndex !== cache.length) throw new SourceError('invalid_content', 'Invalid source error record');
    remote.lastError = { code: e.code, message: e.message, at: e.at, chapterIndex: e.chapterIndex };
  }
  return { key: `${id}:${revision}`, id, revision, title: catalog.title, author: catalog.author,
    filename: 'remote.md', text, sourceHash: digest(text), totalChars: offset, parserVersion: 1, segments, remote };
}
