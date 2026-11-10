import { randomUUID } from 'node:crypto';
import { fetchCatalog, fetchChapter } from './biquge.ts';
import { SourceHttp } from './source-http.ts';
import { SourceError, type HtmlFetcher, type SourceCatalog, type CachedChapter } from './source-types.ts';
import type { Library } from './library.ts';

function sourceError(error: unknown, signal?: AbortSignal): SourceError {
  if (signal?.aborted) return new SourceError('cancelled', 'Source request cancelled');
  if (error instanceof SourceError) return error;
  if (error instanceof Error && /exceeds|limit reached|library is full/i.test(error.message)) return new SourceError('limit', 'Current cache or storage limit reached; previous text and progress are preserved');
  return new SourceError('temporary', 'Source retrieval or cache storage failed; no chapters were skipped');
}
/** Fetch complete chapters on demand, never advance reading progress or silently skip a missing chapter. */
export class Sources {
  private preview?: { token: string; catalog: SourceCatalog; chapter: CachedChapter; generation: number; expiresAt: number };
  async detect(url: string, signal?: AbortSignal) {
    this.preview = undefined; const generation = this.library.generation();
    const catalog = await fetchCatalog(url, this.get, signal); const chapter = await fetchChapter(catalog, 0, this.get, signal); signal?.throwIfAborted();
    const token = randomUUID(); this.preview = { token, catalog, chapter, generation, expiresAt: Date.now()+600000 };
    return { token, title: catalog.title, note: '首章正文已获取；其余章节尚未验证。确认后加入书架。' };
  }
  accept(token: unknown) { const p = this.preview; if (!p || token !== p.token || Date.now() >= p.expiresAt || p.generation !== this.library.generation()) throw new Error('Source preview expired; detect again');
    const result = this.library.importCatalog(p.catalog, p.generation, p.chapter); this.preview = undefined; return result;
  }
  private readonly get: HtmlFetcher;
  private readonly inFlight = new Map<string, Promise<void>>();
  constructor(private readonly library: Library, get?: HtmlFetcher, networkAllowed = () => true) {
    const http = new SourceHttp();
    this.get = (url, signal) => {
      if (!networkAllowed()) throw new SourceError('restricted', 'Network book access is disabled');
      return get ? get(url, signal) : http.get(url, signal);
    };
  }
  async resolve(url: string, signal?: AbortSignal) {
    const generation = this.library.generation();
    const catalog = await fetchCatalog(url, this.get, signal);
    signal?.throwIfAborted();
    const imported = this.library.importCatalog(catalog, generation);
    // Probe one complete chapter for actual readability, not just metadata or an introduction.
    const demand = this.library.sourceDemand(imported.book.key)!;
    if (demand.index === 0) {
      try {
        const chapter = await fetchChapter(catalog, 0, this.get, signal);
        signal?.throwIfAborted(); this.library.cacheChapter(demand.key, generation, chapter);
      } catch (error) {
        const failure = sourceError(error, signal);
        if (!signal?.aborted) this.library.sourceFailed(demand.key, generation, failure);
        if (signal?.aborted || failure.code === 'cancelled') throw failure;
      }
    }
    return { duplicate: imported.duplicate, book: this.library.list().find(b => b.key === imported.book.key),
      note: 'Catalog snapshot imported; only whole cached chapters are readable. Selecting the book starts from the first chapter, even if a middle-chapter link was supplied.' };
  }
  async ensureNext(signal?: AbortSignal): Promise<void> {
    const demand = this.library.sourceDemand();
    if (!demand?.needsNext) return;
    if (demand.paused) throw new SourceError('cancelled', 'Reading is paused');
    const key = `${demand.key}:${demand.generation}:${demand.index}`;
    const previous = this.inFlight.get(key);
    if (previous) { await previous; signal?.throwIfAborted(); return; }
    const operation = (async () => {
      try {
        const chapter = await fetchChapter(demand.catalog, demand.index, this.get, signal);
        signal?.throwIfAborted();
        this.library.cacheChapter(demand.key, demand.generation, chapter);
      } catch (error) {
        const failure = sourceError(error, signal);
        if (!signal?.aborted) this.library.sourceFailed(demand.key, demand.generation, failure);
        throw failure;
      }
    })();
    this.inFlight.set(key, operation);
    try { await operation; } finally { this.inFlight.delete(key); }
  }
}
