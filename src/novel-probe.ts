/**
 * Independent per-source page probe.
 *
 * The text gate in novel-integrity can only see what so-novel saved. A source
 * that paginates a chapter but has no pagination rule (or whose navigation text
 * was filtered out) can still produce a plausible-looking first page. For a
 * source with a probe selector we fetch the chapter page ourselves, follow its
 * in-chapter pagination and check that the downloaded body contains a mid-page
 * slice from every source page.
 *
 * Only hosts listed by the source spec are requested. All requests still go
 * through SourceHttp's DNS/private-address checks and redirect validation.
 */
import { load } from 'cheerio';
import { SourceHttp } from './source-http.ts';
import { stripLeadingTitle, type CatalogChapter, type DownloadChapterFile, type NovelIntegrityIssue } from './novel-integrity.ts';
import { SourceError } from './source-types.ts';
import type { NovelSourceSpec } from './novel-sources.ts';

export interface NovelPageProbe {
  readonly name: string;
  /** Returns only probe-specific issues; text-level issues are decided elsewhere. */
  probe(source: NovelSourceSpec, catalog: CatalogChapter[], files: DownloadChapterFile[], signal?: AbortSignal): Promise<NovelIntegrityIssue[]>;
}

export interface ProbeHttp {
  get(url: string, signal?: AbortSignal): Promise<{ url: string; html: string }>;
}

const MAX_PAGES = 12;
const DEFAULT_NEXT = /^(下一页|下一頁|下页|下頁|next)$/iu;

function normalized(text: string): string {
  return text.replace(/\s+/gu, '');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); reject(signal?.reason); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function midSlice(text: string, length = 48): string | null {
  const clean = normalized(text);
  if (clean.length < length * 2) return clean.length >= 16 ? clean : null;
  const start = Math.max(0, Math.floor(clean.length / 2) - Math.floor(length / 2));
  return clean.slice(start, start + length);
}

export class SourcePageProbe implements NovelPageProbe {
  readonly name = 'source-page-probe-v1';
  private readonly clients = new Map<string, ProbeHttp>();

  constructor(
    private readonly httpFactory: (host: string, encoding?: string) => ProbeHttp = (host, encoding) =>
      new SourceHttp({ hosts: [host], intervalMs: 250, timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024, ...(encoding ? { encoding } : {}) }),
  ) {}

  async probe(source: NovelSourceSpec, catalog: CatalogChapter[], files: DownloadChapterFile[], signal?: AbortSignal): Promise<NovelIntegrityIssue[]> {
    if (!source.probe) return [];
    const client = this.client(source);
    const byOrder = new Map(files.map((file) => [file.order, file]));
    const issues: NovelIntegrityIssue[] = [];
    for (const chapter of [...catalog].sort((a, b) => a.order - b.order)) {
      signal?.throwIfAborted();
      const file = byOrder.get(chapter.order);
      if (!file) continue; // Missing files are already a text-gate issue.
      const downloaded = normalized(stripLeadingTitle(file.text, chapter.title));
      let pages: string[];
      try { pages = await this.pages(source, client, chapter.url, signal); }
      catch (error) {
        if (signal?.aborted) throw error;
        issues.push({ code: 'page_probe_unavailable', message: `Chapter ${chapter.order}: page probe failed: ${(error as Error).message}`, chapter: chapter.order });
        continue;
      }
      if (!pages.length) {
        issues.push({ code: 'page_probe_unavailable', message: `Chapter ${chapter.order}: source page contained no readable body`, chapter: chapter.order });
        continue;
      }
      let missingSlice = false;
      for (const page of pages) {
        const slice = midSlice(page);
        if (slice && !downloaded.includes(slice)) { missingSlice = true; break; }
      }
      if (missingSlice) {
        issues.push({ code: 'page_probe_missing_page', message: `Chapter ${chapter.order}: the downloaded body does not contain text found on a source page`, chapter: chapter.order });
        continue;
      }
      if (pages.length === 1) {
        const sourceLength = normalized(pages[0]!).length;
        if (sourceLength >= 300 && downloaded.length < sourceLength * 0.85) {
          issues.push({ code: 'page_probe_short', message: `Chapter ${chapter.order}: downloaded body is ${Math.round(downloaded.length / sourceLength * 100)}% of the source page`, chapter: chapter.order });
        }
      }
    }
    return issues;
  }

  private client(source: NovelSourceSpec): ProbeHttp {
    const key = `${source.host}|${source.probe?.encoding ?? ''}`;
    let client = this.clients.get(key);
    if (!client) { client = this.httpFactory(source.host, source.probe?.encoding); this.clients.set(key, client); }
    return client;
  }

  private async getWithRetry(client: ProbeHttp, url: string, signal?: AbortSignal): Promise<{ url: string; html: string }> {
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await client.get(url, signal); }
      catch (error) {
        last = error;
        if (signal?.aborted) throw error;
        const code = error instanceof SourceError ? error.code : 'temporary';
        if (code !== 'temporary') throw error;
        if (attempt < 3) await delay(400 * attempt, signal);
      }
    }
    throw last;
  }

  private async pages(source: NovelSourceSpec, client: ProbeHttp, startUrl: string, signal?: AbortSignal): Promise<string[]> {
    const result: string[] = [];
    const seen = new Set<string>();
    let url: string | null = startUrl;
    for (let page = 0; page < MAX_PAGES && url; page++) {
      signal?.throwIfAborted();
      if (seen.has(url)) break;
      seen.add(url);
      let html: string;
      try { html = (await this.getWithRetry(client, url, signal)).html; }
      catch (error) {
        if (signal?.aborted) throw error;
        const code = error instanceof SourceError ? error.code : 'temporary';
        throw new SourceError(code === 'cancelled' ? 'cancelled' : 'temporary', `Page probe could not read chapter page ${page + 1}: ${(error as Error).message}`);
      }
      const $ = load(html);
      const selector = source.probe?.content ?? '#content';
      const body = $(selector).length ? $(selector).map((_, element) => $(element).text()).get().join('\n') : '';
      if (body.trim()) result.push(body);
      url = nextPageUrl($, url, source.probe?.nextText, body);
    }
    return result;
  }
}

function nextPageUrl($: ReturnType<typeof load>, current: string, nextText?: RegExp, body = ''): string | null {
  const base = current.replace(/[?#].*$/u, '').replace(/\.html$/iu, '');
  const host = new URL(current).host;
  const matcher = nextText ?? DEFAULT_NEXT;
  // Some sites label the in-chapter page link "下一章" while pointing at
  // <chapter>_2.html. The page footer is authoritative: if it says page x/y,
  // follow the href matching <base>_<x+1>.html even when the link text differs.
  const counter = body.match(/第\s*[（(]?\s*(\d+)\s*[/／]\s*(\d+)\s*[)）]?\s*页/u);
  if (counter && Number(counter[1]) < Number(counter[2])) {
    const wanted = `${base}_${Number(counter[1]) + 1}.html`;
    let numbered: string | null = null;
    $('a').each((_, element) => {
      if (numbered) return;
      const href = $(element).attr('href');
      if (!href) return;
      let absolute: URL;
      try { absolute = new URL(href, current); } catch { return; }
      if (absolute.host === host && absolute.href.replace(/[?#].*$/u, '') === wanted) numbered = absolute.href;
    });
    if (numbered) return numbered;
  }
  let next: string | null = null;
  $('a').each((_, element) => {
    if (next) return;
    const href = $(element).attr('href');
    const text = $(element).text().trim();
    if (!href || href.startsWith('#') || /^javascript:/iu.test(href) || !matcher.test(text)) return;
    let absolute: URL;
    try { absolute = new URL(href, current); } catch { return; }
    if (absolute.host !== host) return;
    const clean = absolute.href.replace(/[?#].*$/u, '');
    if (clean === current) return;
    if (clean.startsWith(base) || /_\d+\.html$/iu.test(clean)) next = absolute.href;
  });
  return next;
}
