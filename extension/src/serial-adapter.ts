import { fetchCatalog, fetchChapter } from './biquge.ts';
import { SourceHttp } from './source-http.ts';
import { SourceError, type ChapterLink, type HtmlFetcher, type SourceCatalog } from './source-types.ts';
import { chapterId, serialCatalogHash, type SerialCapabilities, type SerialChapter, type SerialSourceAdapter } from './serial-types.ts';

/** Read-only HTML adapter for the already-supported public Biquge host. Authorization is not implied by technical access. */
export class BiqugeSerialAdapter implements SerialSourceAdapter {
  readonly id = 'biquge-02345-v1';
  readonly capabilities: SerialCapabilities = { catalog: true, chapterContent: true, stableChapterId: true, chapterRevision: false,
    publicationStatus: true, cancellation: true, conditionalRequest: false, rateLimit: 'observed' };
  readonly authorization = 'unknown' as const;
  readonly authorizationNote = '公开聚合站，未取得批量自动读取、缓存或模型处理授权；仅本机个人阅读缓存。';
  private readonly get: HtmlFetcher;
  constructor(get?: HtmlFetcher, options: { intervalMs?: number; timeoutMs?: number } = {}) {
    const http = new SourceHttp({ intervalMs: options.intervalMs ?? 2100, timeoutMs: options.timeoutMs ?? 45000 });
    this.get = get ?? ((url, signal) => http.get(url, signal));
  }
  async catalog(binding: { bookUrl: string }, signal: AbortSignal): Promise<SourceCatalog> {
    const raw = await fetchCatalog(binding.bookUrl, this.get, signal);
    const chapters: ChapterLink[] = raw.chapters.map((chapter) => ({ ...chapter, id: chapter.url }));
    const catalog: SourceCatalog = { ...raw, adapter: this.id, chapters, complete: true, pageCount: raw.pageCount ?? 1, hash: '' };
    catalog.hash = serialCatalogHash(catalog);
    return catalog;
  }
  async chapter(binding: { bookUrl: string }, chapter: ChapterLink, signal: AbortSignal): Promise<SerialChapter> {
    const now = new Date().toISOString();
    const synthetic: SourceCatalog = { adapter: this.id, bookUrl: binding.bookUrl, title: 'chapter probe', author: '',
      declaredTotal: 1, chapters: [chapter], fetchedAt: now, hash: '', publicationStatus: 'unknown', complete: true, pageCount: 1 };
    const cached = await fetchChapter(synthetic, 0, this.get, signal);
    if (cached.index !== 0) throw new SourceError('invalid_content', 'Chapter adapter returned an unexpected index');
    return { id: chapterId(chapter), title: chapter.title, url: chapter.url, revision: chapter.revision ?? null,
      text: cached.text, hash: cached.hash, pages: cached.pages.map((page) => ({ url: page.url, hash: page.hash })), fetchedAt: cached.fetchedAt };
  }
}
export function serialAdapter(id: string): SerialSourceAdapter | null {
  if (id === 'biquge-02345-v1') return new BiqugeSerialAdapter();
  return null;
}
