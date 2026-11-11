/**
 * Real-source smoke test for the "recommend a book -> search by title/author
 * -> validate candidate" path.
 *
 * For every work: run the production search (all curated sources), keep exact
 * candidates, then run the same catalog preflight that auto-acquire uses
 * (toc + assessNovelDownload catalogOnly). Nothing is downloaded, imported or
 * written to the shelf. First passing candidate ends the work; every failed
 * attempt keeps its issue codes as evidence.
 *
 * Usage: node --import tsx scripts/check-popular-20.mts [--limit N] [--book 序号] [--books 列表.json] [--out 后缀]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NovelEngine } from '../src/novel-engine.ts';
import { NovelFetches, isAbridgedEdition } from '../src/novel-fetch.ts';
import { NOVEL_SOURCES } from '../src/novel-sources.ts';
import type { NovelSearchCandidate } from '../src/novel-match.ts';

const ENGINE_DIR = process.env.BOOKFISH_ENGINE_DIR
  ?? 'E:/zcdfy/Coopanion/data/home/companion/data/bookfish/novel-engine/versions/bookfish-runtime-1.12.0-bf1-win32-x64-mwa8n73a';

interface BookSpec { title: string; author: string; category: string; note?: string }

const DEFAULT_BOOKS: BookSpec[] = [
  { title: '夜无疆', author: '辰东', category: '东方玄幻', note: '2026 起点/番茄双榜头部' },
  { title: '诡秘之主', author: '爱潜水的乌贼', category: '克苏鲁奇幻' },
  { title: '宿命之环', author: '爱潜水的乌贼', category: '奇幻' },
  { title: '道诡异仙', author: '狐尾的笔', category: '诡异修仙' },
  { title: '深海余烬', author: '远瞳', category: '科幻' },
  { title: '光阴之外', author: '耳根', category: '仙侠' },
  { title: '赤心巡天', author: '情何以甚', category: '仙侠' },
  { title: '万相之王', author: '天蚕土豆', category: '玄幻' },
  { title: '大奉打更人', author: '卖报小郎君', category: '历史探案' },
  { title: '十日终焉', author: '杀虫队队员', category: '悬疑无限流' },
  { title: '轮回乐园', author: '那一只蚊子', category: '无限流' },
  { title: '长夜余火', author: '爱潜水的乌贼', category: '末世' },
  { title: '不科学御兽', author: '轻泉流响', category: '轻小说御兽' },
  { title: '谁让他修仙的！', author: '最白的乌鸦', category: '仙侠喜剧' },
  { title: '玄鉴仙族', author: '季越人', category: '仙侠群像' },
  { title: '剑来', author: '烽火戏诸侯', category: '武侠仙侠' },
  { title: '赘婿', author: '愤怒的香蕉', category: '历史' },
  { title: '全职高手', author: '蝴蝶蓝', category: '游戏竞技' },
  { title: '女将星', author: '千山茶客', category: '古言女频' },
  { title: '我有一座冒险屋', author: '我会修空调', category: '悬疑灵异' },
];

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const bookArg = args.indexOf('--book');
const booksArg = args.indexOf('--books');
const outArg = args.indexOf('--out');
const BOOKS: BookSpec[] = booksArg >= 0
  ? JSON.parse(readFileSync(args[booksArg + 1]!, 'utf8')) as BookSpec[]
  : DEFAULT_BOOKS;
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : BOOKS.length;
const only = bookArg >= 0 ? Number(args[bookArg + 1]) : 0;
const workDir = join(process.cwd(), 'output', `popular-20-work-${Date.now()}`);
mkdirSync(workDir, { recursive: true });

const engine = new NovelEngine({ engineDir: ENGINE_DIR, workDir });
const fetches = new NovelFetches(engine, () => { throw new Error('importer must never run in this test'); }, {
  workDir,
  sources: NOVEL_SOURCES,
  searchSourceIds: NOVEL_SOURCES.map((source) => source.id),
  maxTasks: 4,
});

interface Attempt {
  source: string;
  sourceId: number;
  url: string;
  latestChapter?: string;
  ok: boolean;
  chapters: number;
  reason?: string;
  issues: Array<{ code: string; message: string }>;
  ms: number;
  abridged?: boolean;
}

interface BookResult {
  index: number;
  title: string;
  author: string;
  category: string;
  search: { ok: boolean; exact: number; total: number; sources: string[]; error?: string; ms: number; suggestedExact?: number };
  suggestion?: { title: string; author: string; sources: number };
  abridged?: { chapters: number; largestChapters: number };
  attempts: Attempt[];
  verdict: 'pass' | 'fail';
  reason?: string;
}

const startedAt = new Date().toISOString();
const results: BookResult[] = [];

console.log(`engine: ${ENGINE_DIR}`);
console.log(`engine available: ${JSON.stringify(engine.availability())}`);
console.log(`sources: ${NOVEL_SOURCES.map((source) => `${source.id}:${source.name}`).join(', ')}`);

for (const [index, book] of BOOKS.entries()) {
  if (only && index + 1 !== only) continue;
  if (results.length >= limit) break;
  const row: BookResult = {
    index: index + 1, title: book.title, author: book.author, category: book.category,
    search: { ok: false, exact: 0, total: 0, sources: [], ms: 0 }, attempts: [], verdict: 'fail',
  };
  const searchStarted = Date.now();
  let candidates: Array<NovelSearchCandidate & { match: string }> = [];
  let suggestions: Array<{ title: string; author: string; sources: number }> = [];
  try {
    const found = await fetches.searchDetailed(book.title, '');
    candidates = found.candidates;
    suggestions = found.suggestions;
    row.search.ok = true;
  } catch (error) {
    row.search.error = (error as Error).message.slice(0, 500);
  }
  row.search.ms = Date.now() - searchStarted;
  let exact = candidates.filter((candidate) => candidate.match === 'exact');
  row.search.exact = exact.length;
  row.search.total = candidates.length;
  // A short/abbreviated title gets a full-title hint; retry with that title the
  // same way the panel's "search this title" button does.
  if (row.search.ok && !exact.length && suggestions.length) {
    // Prefer the hint by the author the user asked for; the panel lists every
    // hint, but the test knows which book it means.
    const wanted = book.author.replace(/\s+/gu, '');
    const hint = suggestions.find((item) => item.author.replace(/\s+/gu, '') === wanted) ?? suggestions[0]!;
    row.suggestion = { title: hint.title, author: hint.author, sources: hint.sources };
    const retried = await fetches.searchDetailed(hint.title, hint.author);
    exact = retried.candidates.filter((candidate) => candidate.match === 'exact');
    row.search.suggestedExact = exact.length;
    console.log(`  [${book.title}] 没有精确匹配，按提示《${hint.title}》重试：${exact.length} 个候选`);
  }
  row.search.sources = [...new Set(exact.map((candidate) => `${candidate.source.id}:${candidate.source.name}`))];

  if (row.search.ok && !exact.length) {
    row.reason = `搜索返回 ${candidates.length} 个候选，但没有书名精确匹配的版本${suggestions.length ? `（提示过《${suggestions[0]!.title}》，重试仍无精确候选）` : '（书名匹配但作者/书源不同或只有近似结果）'}`;
  }
  for (const candidate of exact.slice(0, 6)) {
    const at = Date.now();
    const check = await fetches.checkCandidate(candidate);
    row.attempts.push({
      source: candidate.source.name, sourceId: candidate.source.id, url: candidate.url,
      latestChapter: candidate.latestChapter,
      ok: check.ok, chapters: check.chapters,
      ...(check.reason ? { reason: check.reason } : {}),
      issues: check.issues.map((issue) => ({ code: issue.code, message: issue.message })),
      ms: Date.now() - at,
    });
    console.log(`  [${book.title}] ${candidate.source.name}: ${check.ok ? 'PASS' : 'FAIL'} (${check.chapters} 章${check.reason ? `, ${check.reason}` : ''})`);
  }
  // Mirror the panel: a passing edition that is a tiny fraction of the largest
  // edition of the same work is a stub, not an acquirable version.
  const largest = row.attempts.reduce((max, attempt) => Math.max(max, attempt.chapters), 0);
  for (const attempt of row.attempts) if (attempt.ok && isAbridgedEdition(attempt.chapters, largest)) attempt.abridged = true;
  const passed = row.attempts.find((attempt) => attempt.ok && !attempt.abridged);
  const stub = row.attempts.find((attempt) => attempt.ok && attempt.abridged);
  if (!passed && stub) row.abridged = { chapters: stub.chapters, largestChapters: largest };
  row.verdict = passed ? 'pass' : 'fail';
  if (!passed && !row.reason) {
    row.reason = stub
      ? `只找到疑似残缺版本：${stub.source} ${stub.chapters} 章，其他候选最多 ${largest} 章`
      : row.attempts.length
        ? `全部 ${row.attempts.length} 个精确候选未通过目录校验：${[...new Set(row.attempts.flatMap((attempt) => attempt.issues.map((issue) => issue.code)))].join(', ') || row.attempts[0]!.reason}`
        : '没有可校验的精确候选';
  }
  results.push(row);
  console.log(`${String(row.index).padStart(2, '0')}. ${book.title} / ${book.author} [${book.category}] -> ${row.verdict.toUpperCase()} 候选 ${exact.length}/${candidates.length} 通过源 ${passed?.source ?? (stub ? '仅残缺版' : '-')} 用时 ${((Date.now() - searchStarted) / 1000).toFixed(1)}s`);
  writeFileSync(join(workDir, 'progress.json'), `${JSON.stringify({ startedAt, updatedAt: new Date().toISOString(), results }, null, 2)}\n`, 'utf8');
}

const summary = {
  startedAt, finishedAt: new Date().toISOString(),
  engineDir: ENGINE_DIR,
  engine: engine.availability(),
  sources: NOVEL_SOURCES.map((source) => ({ id: source.id, name: source.name, host: source.host })),
  total: results.length,
  passed: results.filter((row) => row.verdict === 'pass').length,
  failed: results.filter((row) => row.verdict === 'fail').length,
  noCandidate: results.filter((row) => row.search.ok && row.search.exact === 0).length,
  searchError: results.filter((row) => !row.search.ok).length,
  results,
};
const outFile = join(process.cwd(), 'output', `popular-20${outArg >= 0 ? `-${args[outArg + 1]}` : ''}-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(`\n${summary.passed}/${summary.total} 通过；证据：${outFile}`);
process.exitCode = summary.failed ? 1 : 0;
