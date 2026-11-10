import { load } from 'cheerio';
import { digest } from './books.ts';
import { sourceUrl } from './source-http.ts';
import { SourceError, type CachedChapter, type ChapterLink, type HtmlFetcher, type SourceCatalog } from './source-types.ts';

export function catalogUrl(input: string): string {
  const url = sourceUrl(input);
  url.protocol = 'https:';
  const match = url.pathname.match(/^\/([a-zA-Z0-9_-]+)\/(?:index_\d+\.html|\d+(?:_\d+)?\/)?$/);
  if (!match) throw new SourceError('unsupported', 'Provide a novel directory or chapter URL, not the site home or search page');
  url.pathname = `/${match[1]}/`; return url.href;
}
export function catalogHash(catalog: Pick<SourceCatalog, 'bookUrl' | 'title' | 'author' | 'chapters' | 'publicationStatus'>): string {
  return digest(JSON.stringify([catalog.bookUrl, catalog.title, catalog.author, catalog.publicationStatus, catalog.chapters]));
}
function classify(html: string): void {
  const $ = load(html);
  const body = $('body').text();
  if (/just a moment|checking your browser|人机验证|访问验证|验证码/i.test($('title').text()) || $('.cf-challenge, .captcha').length) throw new SourceError('restricted', 'Source requires browser verification');
  if ($('input[type=password]').length) throw new SourceError('needs_login', 'Source requires login');
  if (body.length < 600 && /购买本章|本章为VIP|付费阅读|订阅后阅读/.test(body)) throw new SourceError('restricted', 'Chapter is not publicly readable');
  if (body.length < 600 && /登录后阅读|请先登录/.test(body)) throw new SourceError('needs_login', 'Chapter requires login');
  if (body.length < 600 && /章节不存在|内容不存在|章节已删除/.test(body)) throw new SourceError('missing', 'Chapter content is missing');
}
function linked(value: string, base: string, bookUrl: string): string {
  const url = sourceUrl(new URL(value, base).href);
  const root = new URL(bookUrl);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) throw new SourceError('invalid_content', 'Source link points outside the selected book');
  return url.href;
}
export function parseCatalogPage(html: string, url: string, expectedBookUrl: string) {
  classify(html);
  const $ = load(html);
  const title = $('meta[property="og:novel:book_name"]').attr('content')?.trim();
  const author = $('meta[property="og:novel:author"]').attr('content')?.trim();
  const status = $('meta[property="og:novel:status"]').attr('content')?.trim() ?? '';
  const publicationStatus: SourceCatalog['publicationStatus'] = /完本|完结/.test(status) ? 'finished' : /连载/.test(status) ? 'ongoing' : 'unknown';
  const list = $('.book_list2');
  if (!title || title.length > 200 || !author || author.length > 100 || list.length !== 1) throw new SourceError('invalid_content', 'Book metadata or complete chapter list was not found; introduction is not readable text');
  const total = Number($('body').text().match(/共\s*(\d+)\s*章/)?.[1]);
  if (!Number.isInteger(total) || total < 1 || total > 5000) throw new SourceError('limit', 'A declared chapter count between 1 and 5000 is required');
  const chapters: ChapterLink[] = [];
  list.find('a[href]').each((_, element) => {
    const anchor = $(element); const chapterTitle = anchor.text().trim();
    if (!chapterTitle || chapterTitle.length > 200) throw new SourceError('invalid_content', 'Invalid chapter title');
    const target = linked(anchor.attr('href')!, url, expectedBookUrl);
    if (!/^\d+\/$/.test(new URL(target).pathname.slice(new URL(expectedBookUrl).pathname.length))) throw new SourceError('invalid_content', 'Unexpected chapter link structure');
    chapters.push({ title: chapterTitle, url: target });
  });
  const pages = $('.pages').text().match(/(\d+)\s*\/\s*(\d+)/);
  const pageCount = pages ? Number(pages[2]) : 1;
  const pageIndex = pages ? Number(pages[1]) : 1;
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 50 || pageIndex < 1 || pageIndex > pageCount) throw new SourceError('limit', 'Unsupported catalog pagination');
  if (!chapters.length || new Set(chapters.map(c => c.url)).size !== chapters.length) throw new SourceError('invalid_content', 'Catalog contains empty or duplicate chapter ranges');
  return { title, author, total, chapters, pageCount, pageIndex, publicationStatus };
}
export async function fetchCatalog(input: string, get: HtmlFetcher, signal?: AbortSignal): Promise<SourceCatalog> {
  const bookUrl = catalogUrl(input);
  const firstPage = await get(bookUrl, signal);
  if (catalogUrl(firstPage.url) !== bookUrl) throw new SourceError('invalid_content', 'Source redirected to a different book');
  const first = parseCatalogPage(firstPage.html, firstPage.url, bookUrl);
  if (first.pageIndex !== 1) throw new SourceError('invalid_content', 'Catalog did not begin at page 1');
  const chapters = [...first.chapters];
  for (let page = 2; page <= first.pageCount; page++) {
    signal?.throwIfAborted();
    const result = await get(new URL(`index_${page}.html`, bookUrl).href, signal);
    const parsed = parseCatalogPage(result.html, result.url, bookUrl);
    if (catalogUrl(result.url) !== bookUrl || parsed.pageIndex !== page || parsed.pageCount !== first.pageCount || parsed.total !== first.total || parsed.title !== first.title || parsed.author !== first.author || parsed.publicationStatus !== first.publicationStatus) throw new SourceError('invalid_content', 'Catalog identity or pagination changed during retrieval');
    chapters.push(...parsed.chapters);
  }
  if (chapters.length !== first.total || new Set(chapters.map(c => c.url)).size !== chapters.length) throw new SourceError('missing', 'Catalog is incomplete or has overlapping pages; no chapters will be skipped');
  const catalog: SourceCatalog = { adapter: 'biquge-02345-v1', bookUrl, title: first.title, author: first.author,
    declaredTotal: first.total, publicationStatus: first.publicationStatus, chapters, fetchedAt: new Date().toISOString(), hash: '', complete: true, pageCount: first.pageCount };
  catalog.hash = catalogHash(catalog); return catalog;
}
export function parseChapterPage(html: string, url: string, chapter: ChapterLink, bookUrl: string) {
  classify(html);
  const $ = load(html);
  const article = $('article.font_max');
  const heading = $('h1').first().text().trim().split(/-《/)[0].trim();
  if (article.length !== 1 || heading !== chapter.title) throw new SourceError('invalid_content', 'Expected chapter body or title was not found');
  article.find('script,style,iframe,form,nav,aside,ins,.ad,.advertisement,[hidden]').remove();
  article.find('br').replaceWith('\n'); article.find('p,div').append('\n');
  const raw = article.text().replace(/\r\n?/g, '\n');
  const markers = [...raw.matchAll(/第\s*[（(](\d+)\s*\/\s*(\d+)[)）]\s*页/g)];
  const index = markers.length ? Number(markers[0][1]) : 1;
  const pages = markers.length ? Number(markers[0][2]) : 1;
  if (markers.some(m => Number(m[1]) !== index || Number(m[2]) !== pages) || index < 1 || pages < 1 || index > pages || pages > 12) throw new SourceError('invalid_content', 'Chapter pagination is inconsistent');
  const text = raw.replace(/第\s*[（(]\d+\s*\/\s*\d+[)）]\s*页/g, '').replace(/\u00a0/g, ' ').split('\n').map(s => s.trim()).filter(Boolean).join('\n\n');
  if (Array.from(text).length < 30 || Buffer.byteLength(text) > 256 * 1024) throw new SourceError('invalid_content', 'Chapter text is empty, too short or oversized');
  const root = new URL(chapter.url);
  const expected = index === 1 ? root.href : new URL(root.pathname.replace(/\/$/, `_${index}/`), root).href;
  if (url !== expected) throw new SourceError('invalid_content', 'Chapter page URL does not match its declared position');
  let next: string | undefined;
  if (index < pages) {
    const href = $('#next').attr('href');
    if (!href) throw new SourceError('missing', 'Next chapter page link is missing');
    next = linked(href, url, bookUrl);
    const expectedNext = new URL(root.pathname.replace(/\/$/, `_${index + 1}/`), root).href;
    if (next !== expectedNext) throw new SourceError('missing', 'Next link skips a page or points to another chapter');
  } else {
    const href = $('#next').attr('href');
    if (href) {
      const target = new URL(href, url);
      const continuation = root.pathname.replace(/\/$/, '_');
      if (target.pathname.startsWith(continuation)) throw new SourceError('missing', 'Chapter continuation exists but its page count is missing or inconsistent');
    }
  }
  return { text, index, pages, next };
}
export async function fetchChapter(catalog: SourceCatalog, index: number, get: HtmlFetcher, signal?: AbortSignal): Promise<CachedChapter> {
  const chapter = catalog.chapters[index];
  if (!chapter) throw new SourceError('missing', 'Chapter is not in the catalog snapshot');
  let url: string | undefined = chapter.url;
  const texts: string[] = []; const pages: CachedChapter['pages'] = [];
  let count = 0;
  while (url) {
    signal?.throwIfAborted();
    const response = await get(url, signal);
    const parsed = parseChapterPage(response.html, response.url, chapter, catalog.bookUrl);
    if (parsed.index !== pages.length + 1 || (count && parsed.pages !== count)) throw new SourceError('missing', 'A chapter page is missing or repeated');
    count = parsed.pages;
    texts.push(parsed.text); pages.push({ url: response.url, hash: digest(parsed.text) });
    if (Buffer.byteLength(texts.join('\n\n')) > 256 * 1024) throw new SourceError('limit', 'Chapter exceeds 256 KiB');
    url = parsed.next;
  }
  const text = texts.join('\n\n');
  return { index, text, hash: digest(text), fetchedAt: new Date().toISOString(), pages };
}
