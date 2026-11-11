import type { HtmlFetcher, SourceCatalog } from '../../src/source-types.ts';
import { SourceError } from '../../src/source-types.ts';
import { fetchCatalog } from '../../src/biquge.ts';
export const ROOT = 'https://www.02345.cc/sample/';
export const titles = ['第一章 海边', '第二章 归途', '第三章 灯火'];
export function catalogPage(page = 1, total = 3, title = '合成测试小说') {
  const indices = page === 1 ? [0, 1] : [2];
  return `<html><head><meta property="og:novel:book_name" content="${title}"><meta property="og:novel:author" content="测试作者"><meta property="og:novel:status" content="完本"></head><body><h1>${title}</h1><h2>章节列表，共${total}章</h2><div class="book_list"><a href="${ROOT}999/">最新章节推荐</a></div><div class="book_list2">${indices.map(i => `<a href="${ROOT}${i + 1}/">${titles[i]}</a>`).join('')}</div><div class="pages">${page}/2</div></body></html>`;
}
export function chapterPage(index = 0, page = 1, pages = 1) {
  const body = `海风吹过小屋，伙伴们沿着熟悉的小路慢慢回家，远处的灯光照着归途。这是第${index + 1}章第${page}页的合成正文。`;
  const next = page < pages ? `${ROOT}${index + 1}_${page + 1}/` : `${ROOT}${index + 2}/`;
  return `<html><body><h1>${titles[index]}-《合成测试小说》</h1><article class="font_max"><script>throw Error('must not run')</script><div class="ad">广告内容</div>第(${page}/${pages})页<br>${body}<br>第(${page}/${pages})页</article><a id="next" href="${next}">下一章</a></body></html>`;
}
export function fixture() {
  const pages = new Map<string, string>([[ROOT, catalogPage()], [ROOT + 'index_2.html', catalogPage(2)],
    [ROOT + '1/', chapterPage(0, 1, 2)], [ROOT + '1_2/', chapterPage(0, 2, 2)], [ROOT + '2/', chapterPage(1)], [ROOT + '3/', chapterPage(2)]]);
  const requests: string[] = [];
  const get: HtmlFetcher = async (url, signal) => {
    signal?.throwIfAborted(); requests.push(url);
    const html = pages.get(url); if (!html) throw new SourceError('missing', 'Fixture page missing');
    return { url, html };
  };
  return { pages, requests, get, catalog: () => fetchCatalog(ROOT, get) };
}
