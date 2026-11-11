/**
 * Book sources exposed by fetch-by-title.
 *
 * IDs and names follow the bundled so-novel main.json order (1-based). Only
 * sources verified to search and return a usable catalog/download are listed;
 * adding one here must also add a page-probe selector when the source's
 * chapter body can be read without JavaScript decoding.
 */
export interface SourceProbeSpec {
  /** CSS selector for the chapter body on the source page. */
  content: string;
  /** Text of an in-chapter next-page control. Next-chapter links are ignored. */
  nextText?: RegExp;
  /** Force GBK for sites whose charset header/prefix is wrong. */
  encoding?: string;
}

export interface NovelSourceSpec {
  id: number;
  name: string;
  host: string;
  /** Book-detail path guard used before a task may start. */
  bookPath: RegExp;
  /** null means the text gate still applies but no independent page probe exists. */
  probe?: SourceProbeSpec | null;
}

export const NOVEL_SOURCES: readonly NovelSourceSpec[] = [
  { id: 5, name: '笔尖中文', host: 'www.xbiquwk.com', bookPath: /^\/\d+_\d+\/$/u, probe: { content: '#content', nextText: /^(下一页|下一頁|下页|下頁)$/iu } },
  { id: 7, name: '阅读库', host: 'www.yeudusk.com', bookPath: /^\/book\/\d+\/$/u, probe: { content: '#content', nextText: /^(下一页|下一頁|下页|下頁)$/iu } },
  { id: 8, name: '笔趣阁365', host: 'www.biquge365.net', bookPath: /^\/book\/\d+\/$/u, probe: { content: '#txt', nextText: /^(下一页|下一頁|下页|下頁)$/iu } },
  { id: 9, name: '第八中文网', host: 'www.d8zw.com', bookPath: /^\/\d+\/\d+\/$/u, probe: { content: 'article.font_max', nextText: /^(下一页|下一頁|下页|下頁)$/iu } },
  { id: 12, name: '新笔趣阁小说网', host: 'www.xbiquge.info', bookPath: /^\/\d+\/\d+\/$/u, probe: { content: 'article.font_max', nextText: /^(下一页|下一頁|下页|下頁)$/iu } },
  { id: 1, name: '香书小说', host: 'www.ibiqugu.net', bookPath: /^\/\d+\/\d+\/$/u, probe: { content: '#content', nextText: /^(下一页|下一頁|下页|下頁)$/iu } },
  { id: 6, name: '悠久小说网', host: 'www.ujxsw.org', bookPath: /^\/book\/\d+\/$/u, probe: { content: '#mlfy_main_text > div.read-content > p', nextText: /^(下一页|下一頁|下页|下頁)$/iu } },
  // Chapter body is written by JavaScript and base64-decoded; the HTML probe
  // cannot compare it, so this source relies on the text gate only.
  { id: 11, name: '少年小说网', host: 'www.snxsw.com', bookPath: /^\/book\/\d+\/$/u, probe: null },
];

export function sourceById(id: number, sources: readonly NovelSourceSpec[] = NOVEL_SOURCES): NovelSourceSpec | undefined {
  return sources.find((source) => source.id === id);
}

export const NOVEL_SOURCE_IDS: readonly number[] = NOVEL_SOURCES.map((source) => source.id);
