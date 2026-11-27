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
  /**
   * One shared chapter download per key. Each caller subscribes with its own
   * AbortSignal; cancelling one caller only removes that subscription. The
   * underlying request is aborted when the last subscriber leaves.
   */
  private readonly inFlight = new Map<string, SharedFetch>();
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
    await this.fetchNext(demand, signal);
  }
  /**
   * Same validated fetch/append path as ensureNext, but keyed to the cached end
   * instead of the confirmed frontier. The voice may run ahead of confirmation;
   * this appends text only and never advances reading.
   */
  async ensureNextCached(signal?: AbortSignal): Promise<void> {
    const demand = this.library.voiceSourceDemand();
    if (!demand?.needsNext) return;
    await this.fetchNext(demand, signal);
  }
  private async fetchNext(demand: NonNullable<ReturnType<Library['sourceDemand']>>, signal?: AbortSignal): Promise<void> {
    if (demand.paused) throw new SourceError('cancelled', 'Reading is paused');
    if (signal?.aborted) throw new SourceError('cancelled', 'Source request cancelled');
    const key = `${demand.key}:${demand.generation}:${demand.index}`;
    let shared = this.inFlight.get(key);
    if (shared?.settled) { this.inFlight.delete(key); shared = undefined; }
    if (!shared) {
      const controller = new AbortController();
      const created: SharedFetch = {
        controller, subscribers: 0, settled: false,
        promise: this.runFetch(demand, controller.signal),
      };
      shared = created;
      this.inFlight.set(key, created);
      // A shared failure is delivered to subscribers; this handler only prevents
      // an unhandled rejection when all subscribers cancelled first.
      void created.promise.then(
        () => { created.settled = true; if (this.inFlight.get(key) === created) this.inFlight.delete(key); },
        () => { created.settled = true; if (this.inFlight.get(key) === created) this.inFlight.delete(key); },
      );
    }
    shared.subscribers += 1;
    const task = shared;
    try {
      if (signal) {
        let onAbort!: () => void;
        const cancelled = new Promise<never>((_, reject) => {
          onAbort = () => reject(new SourceError('cancelled', 'Source request cancelled'));
          signal.addEventListener('abort', onAbort, { once: true });
        });
        try { await Promise.race([task.promise, cancelled]); }
        finally { signal.removeEventListener('abort', onAbort); }
      } else {
        await task.promise;
      }
    } finally {
      task.subscribers -= 1;
      if (task.subscribers === 0 && !task.settled) {
        // No caller is waiting any more: stop the shared download and let a later
        // caller create a fresh task. A late result cannot be reused.
        if (this.inFlight.get(key) === task) this.inFlight.delete(key);
        task.controller.abort();
      }
    }
  }
  private runFetch(demand: NonNullable<ReturnType<Library['sourceDemand']>>, signal: AbortSignal): Promise<void> {
    return (async () => {
      try {
        const chapter = await fetchChapter(demand.catalog, demand.index, this.get, signal);
        signal.throwIfAborted();
        this.library.cacheChapter(demand.key, demand.generation, chapter);
      } catch (error) {
        const failure = sourceError(error, signal);
        // A cancelled shared request is not a source failure; never poison the
        // book's source state when every subscriber simply walked away.
        if (!signal.aborted && failure.code !== 'cancelled') {
          this.library.sourceFailed(demand.key, demand.generation, failure);
        }
        throw failure;
      }
    })();
  }
}

interface SharedFetch {
  controller: AbortController;
  promise: Promise<void>;
  subscribers: number;
  settled: boolean;
}
