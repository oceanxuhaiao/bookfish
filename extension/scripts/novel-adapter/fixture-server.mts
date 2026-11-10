/**
 * Deterministic local fixture for the isolated so-novel adapter.
 *
 * The HTML shape matches the official v1.12.0 rule engine used in the earlier
 * comparison. Every case is original text, so hits and failures are fully
 * reproducible without touching a real book source.
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const FIXTURE_PORT = 18870;

type Case = {
  title: string;
  author: string;
  chapters: number;
  /** Failure injected for one chapter order. */
  failChapter?: number;
  /** A page-limited body that still looks "complete" to the engine. */
  missingPageAt?: number;
  /** Number style for duplicate-edition reproduction. */
  mixed?: boolean;
};

export const FIXTURE_CASES: Record<string, Case> = {
  '/plain/ok/': { title: '海边的信', author: '小鱼', chapters: 3 },
  '/plain/imposter/': { title: '海边的信', author: '同名作者', chapters: 2 },
  '/plain/missing/': { title: '断章书', author: '小鱼', chapters: 3, failChapter: 2 },
  '/plain/pagedmissing/': { title: '漏页书', author: '小鱼', chapters: 3, missingPageAt: 2 },
  '/plain/mixed/': { title: '混版书', author: '小鱼', chapters: 6, mixed: true },
  '/paged/ok/': { title: '分页书', author: '小鱼', chapters: 3 },
};

const CN = ['一', '二', '三', '四', '五', '六'];

function bodyFor(index: number, extra = ''): string {
  const paragraph = [
    '海风吹过码头，小鱼从邮筒里取出一封信。信封上的字迹很熟悉，她坐在石阶上读完了第一行。',
    '山雀停在窗边，远处的渔船缓缓归来。她收好信纸，沿着长长的石板路走向灯火亮起的家。',
    '天色渐暗，邻居端着热汤推开门。两个人谈起明天的集市，决定把修好的木船重新放回水里。',
  ];
  return paragraph.map((line) => `<p>${line}</p>`).join('') + `<p>章节标记_${index}</p>${extra}`;
}

function chapterTitle(testCase: Case, order: number): string {
  if (testCase.mixed && order > 6) return `第${CN[order - 7]}回 另一个版本`;
  return `第${order}章 ${testCase.title}`;
}

function chapterPath(base: string, order: number): string {
  return `${base}c${order}.html`;
}

function meta(testCase: Case): string {
  return `<meta property="og:novel:book_name" content="${testCase.title}">` +
    `<meta property="og:novel:author" content="${testCase.author}">` +
    `<meta name="description" content="原创受控抓取测试">` +
    `<meta property="og:novel:status" content="完本">`;
}

function bookPage(base: string, testCase: Case): string {
  const total = testCase.mixed ? 12 : testCase.chapters;
  const links = Array.from({ length: total }, (_, i) => {
    const order = i + 1;
    return `<dd><a href="${chapterPath(base, order)}">${chapterTitle(testCase, order)}</a></dd>`;
  }).join('');
  return `<html><head>${meta(testCase)}</head><body><h1>${testCase.title}</h1><dl id="list">${links}</dl></body></html>`;
}

function chapterPage(base: string, testCase: Case, order: number, page = 1): { html: string; status: number } {
  if (testCase.failChapter === order) return { html: '暂时无法访问', status: 503 };
  const title = chapterTitle(testCase, order);
  if (testCase.missingPageAt === order && page === 1) {
    // The rule for /plain/ has no nextPage selector, so this first page is all
    // the engine keeps. The visible marker is what the independent gate catches.
    return { html: `<html><body><h1>${title}</h1><div id="content">${bodyFor(order, '<p>本章未完，点击下一页继续阅读</p>')}</div><a id="nextpage" href="${base}c${order}_2.html">下一页</a></body></html>`, status: 200 };
  }
  if (base === '/paged/ok/' && order === 2 && page === 1) {
    return { html: `<html><body><h1>${title}</h1><div id="content">${bodyFor(order)}</div><a id="nextpage" href="${base}c${order}_2.html">下一页</a></body></html>`, status: 200 };
  }
  if (base === '/paged/ok/' && order === 2 && page === 2) {
    return { html: `<html><body><h1>${title}</h1><div id="content">${bodyFor(order, '<p>PAGED_TAIL_912</p>')}</div></body></html>`, status: 200 };
  }
  return { html: `<html><body><h1>${title}</h1><div id="content">${bodyFor(order)}</div></body></html>`, status: 200 };
}

function searchPage(query: string): string {
  const wanted = query.trim();
  const rows = Object.entries(FIXTURE_CASES)
    .filter(([, item]) => item.title.includes(wanted) || item.author.includes(wanted))
    .map(([base, item]) => `<div class="result"><a class="name" href="${base}">${item.title}</a><span class="author">${item.author}</span></div>`)
    .join('');
  return `<html><body>${rows}</body></html>`;
}

export function startFixtureServer(port = FIXTURE_PORT): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const send = (status: number, html: string) => {
      const buffer = Buffer.from(html, 'utf8');
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(buffer.length) });
      res.end(buffer);
    };
    if (url.pathname === '/search') return send(200, searchPage(url.searchParams.get('q') ?? ''));
    const testCase = FIXTURE_CASES[url.pathname];
    if (testCase) return send(200, bookPage(url.pathname, testCase));
    for (const [base, item] of Object.entries(FIXTURE_CASES)) {
      if (!url.pathname.startsWith(base)) continue;
      const rest = url.pathname.slice(base.length);
      const match = rest.match(/^c(\d+)(?:_(\d+))?\.html$/u);
      if (match) {
        const page = chapterPage(base, item, Number(match[1]), Number(match[2] ?? 1));
        return send(page.status, page.html);
      }
    }
    send(404, 'not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** Write a two-source rule file: ID 1 has no nextPage, ID 2 supports pagination. */
export function writeFixtureRules(port: number, file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  const base = `http://127.0.0.1:${port}`;
  const common = {
    needProxy: true,
    search: { url: `${base}/search?q=%s`, method: 'get', result: '.result', bookName: 'a.name', author: '.author' },
    book: {},
    toc: { item: '#list dd a' },
    crawl: { concurrency: 1, minInterval: 80, maxInterval: 120, maxAttempts: 2, retryMinInterval: 60, retryMaxInterval: 90 },
  };
  const rules = [
    { id: 1, url: `${base}/plain/`, name: 'fixture-plain', ...common, chapter: { content: '#content', title: 'h1', paragraphTagClosed: true, filterTxt: '(?!)', filterTag: 'script' } },
    { id: 2, url: `${base}/paged/`, name: 'fixture-paged', ...common, chapter: { content: '#content', title: 'h1', paragraphTagClosed: true, nextPage: '#nextpage', filterTxt: '(?!)', filterTag: 'script' } },
  ];
  writeFileSync(file, `${JSON.stringify(rules)}\n`, 'utf8');
  return file;
}

// Allow `tsx fixture-server.mts` for manual probing.
if (process.argv[1] && process.argv[1].endsWith('fixture-server.mts')) {
  const server = await startFixtureServer();
  console.log(`fixture listening on http://127.0.0.1:${FIXTURE_PORT}`);
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}
