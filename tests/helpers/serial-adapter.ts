import { SourceError } from '../../src/source-types.ts';
import type { ChapterLink, SourceCatalog } from '../../src/source-types.ts';
import { serialCatalogHash, type SerialCapabilities, type SerialChapter, type SerialSourceAdapter } from '../../src/serial-types.ts';
import { digest } from '../../src/books.ts';

export const CONTROLLED_BOOK_URL = 'https://serial.test/book/1/';
export function controlledCatalog(chapters: ChapterLink[], status: 'ongoing' | 'finished' | 'unknown' = 'ongoing', complete = true): SourceCatalog {
  const value: SourceCatalog = { adapter: 'controlled-serial-v1', bookUrl: CONTROLLED_BOOK_URL, title: '受控连载', author: '测试作者',
    declaredTotal: chapters.length, chapters: chapters.map((c) => ({ ...c })), publicationStatus: status,
    fetchedAt: new Date().toISOString(), hash: '', complete, pageCount: 1 };
  value.hash = serialCatalogHash(value); return value;
}
export function controlledLink(n: number, title = `第${n}章`, revision?: string): ChapterLink {
  return { id: `c${n}`, title, url: `${CONTROLLED_BOOK_URL}${n}/`, ...(revision ? { revision } : {}) };
}
export function controlledChapter(link: ChapterLink, text: string, pageCount = 1): SerialChapter {
  const pages = Array.from({ length: pageCount }, (_, i) => ({ url: i === 0 ? link.url : link.url.replace(/\/$/, `_${i + 1}/`), hash: digest(`${link.id}:${i}:${text.slice(0, 30)}`) }));
  return { id: link.id ?? link.url, title: link.title, url: link.url, revision: link.revision ?? null, text, hash: digest(text),
    pages, fetchedAt: new Date().toISOString() };
}
export class ControlledAdapter implements SerialSourceAdapter {
  readonly id = 'controlled-serial-v1';
  readonly capabilities: SerialCapabilities = { catalog: true, chapterContent: true, stableChapterId: true, chapterRevision: true,
    publicationStatus: true, cancellation: true, conditionalRequest: false, rateLimit: 'observed' };
  readonly authorization = 'allowed' as const;
  readonly authorizationNote = '原创受控源，仅用于故障注入';
  catalogCalls = 0; chapterCalls = 0;
  catalogs: SourceCatalog[] = [];
  chapters = new Map<string, SerialChapter>();
  catalogError: Error | null = null;
  chapterError: ((index: number) => Error | null) | null = null;
  gate: Promise<void> | null = null;
  afterCatalog: (() => void) | null = null;
  constructor(catalog: SourceCatalog, chapters: SerialChapter[] = []) { this.catalogs = [catalog]; for (const c of chapters) this.chapters.set(c.id, c); }
  setCatalog(catalog: SourceCatalog) { this.catalogs = [catalog]; }
  pushCatalog(catalog: SourceCatalog) { this.catalogs.push(catalog); }
  setChapter(c: SerialChapter) { this.chapters.set(c.id, c); }
  async catalog(): Promise<SourceCatalog> {
    this.catalogCalls++;
    if (this.gate) { await this.gate; }
    if (this.catalogError) throw this.catalogError;
    const value = this.catalogs.length > 1 ? this.catalogs.shift()! : this.catalogs[0];
    const cloned = structuredClone(value);
    this.afterCatalog?.();
    return cloned;
  }
  async chapter(_binding: { bookUrl: string }, link: ChapterLink, signal: AbortSignal): Promise<SerialChapter> {
    const index = this.chapterCalls++;
    if (this.gate) await Promise.race([this.gate, new Promise<never>((_, reject) => {
      const abort = () => reject(new SourceError('cancelled', 'Source request cancelled'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    })]);
    signal.throwIfAborted();
    const failure = this.chapterError?.(index);
    if (failure) throw failure;
    const found = this.chapters.get(link.id ?? link.url);
    if (!found) throw new SourceError('missing', `Controlled chapter ${link.id} is missing`);
    return structuredClone(found);
  }
}
