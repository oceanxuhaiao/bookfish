/**
 * Source full-text research harness.
 *
 * Runs short and medium public-domain samples through the production adapter
 * into isolated shelves, then records catalog and text characteristics. It
 * never writes to the live Bookfish library.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library } from '../../src/library.ts';
import { NovelEngine } from '../../src/novel-engine.ts';
import { NovelFetches, type NovelTaskView } from '../../src/novel-fetch.ts';
import type { NovelSearchCandidate } from '../../src/novel-match.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '../..');
const OUT = join(PACKAGE_ROOT, 'output', 'novel-adapter', 'source-research');
mkdirSync(OUT, { recursive: true });
const RUN = join(OUT, 'run');
if (existsSync(RUN)) rmSync(RUN, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });

const engineDir = 'E:/zcdfy/Coopanion/data/home/companion/data/bookfish/novel-engine';
const cases: Array<{ name: string; candidate: NovelSearchCandidate }> = [
  { name: 'source1-aq', candidate: { title: '阿Q正传', author: '鲁迅.', source: { id: 1, name: '香书小说' }, url: 'http://www.ibiqugu.net/150/150114/', revision: '1111111111111111', latestChapter: '', lastUpdateTime: '' } },
  { name: 'source6-aq', candidate: { title: '阿Q正传', author: '鲁迅.', source: { id: 6, name: '悠久小说网' }, url: 'http://www.ujxsw.org/book/115812/', revision: '2222222222222222', latestChapter: '', lastUpdateTime: '' } },
  { name: 'source9-aq', candidate: { title: '阿Q正传', author: '鲁迅.', source: { id: 9, name: '第八中文网' }, url: 'https://www.d8zw.com/45/45256/', revision: '3333333333333333', latestChapter: '', lastUpdateTime: '' } },
  { name: 'source12-aq', candidate: { title: '阿Q正传', author: '鲁迅.', source: { id: 12, name: '新笔趣阁小说网' }, url: 'https://www.xbiquge.info/45/45256/', revision: '4444444444444444', latestChapter: '', lastUpdateTime: '' } },
  { name: 'source8-three-kingdoms', candidate: { title: '三国演义', author: '罗贯中', source: { id: 8, name: '笔趣阁365' }, url: 'https://www.biquge365.net/book/08451/', revision: '5555555555555555', latestChapter: '', lastUpdateTime: '' } },
  { name: 'source11-three-kingdoms', candidate: { title: '三国演义', author: '罗贯中', source: { id: 11, name: '少年小说网' }, url: 'https://www.snxsw.com/book/28134/', revision: '6666666666666666', latestChapter: '', lastUpdateTime: '' } },
];

function newestValidated(managerWork: string): string | null {
  const tasks = join(managerWork, 'engine', 'tasks');
  if (!existsSync(tasks)) return null;
  const dirs = readdirSync(tasks).map((name) => join(tasks, name, 'validated.txt')).filter((file) => existsSync(file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ?? null;
}

function analyze(text: string) {
  const chars = Array.from(text).length;
  const lines = text.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
  const html = (text.match(/<[^>]{1,200}>/gu) ?? []).length;
  const entities = (text.match(/&(?:nbsp|amp|lt|gt|quot|#\d+);/giu) ?? []).length;
  const replacement = (text.match(/\uFFFD/gu) ?? []).length;
  const ads = text.match(/(本章未完|请收藏|最新网址|笔趣阁|一秒记住|天才一秒|手机版阅读|www\.[a-z0-9.-]+|请记住本站)/giu) ?? [];
  const paragraphs = lines.filter((line) => !/^第[0-9零〇一二两三四五六七八九十百千]+[章节回]/u.test(line));
  const lengths = paragraphs.map((line) => Array.from(line).length);
  return {
    chars, paragraphs: paragraphs.length, avgParagraphChars: lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0,
    maxParagraphChars: lengths.length ? Math.max(...lengths) : 0, htmlTags: html, htmlEntities: entities, replacementChars: replacement,
    adHits: ads.length, adSamples: [...new Set(ads)].slice(0, 8),
    firstLine: lines[0]?.slice(0, 120) ?? '', lastLine: lines.at(-1)?.slice(-120) ?? '',
    numberedTitleLines: lines.filter((line) => /^第[0-9零〇一二两三四五六七八九十百千]+[章节回]/u.test(line)).length,
  };
}

async function waitTask(manager: NovelFetches, id: string, timeoutMs: number): Promise<NovelTaskView> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = manager.get(id);
    if (['complete', 'failed', 'cancelled'].includes(task.state)) return task;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  manager.cancel(id);
  return manager.get(id);
}

const results: Array<Record<string, unknown>> = [];
for (const testCase of cases) {
  const shelfDir = join(RUN, testCase.name);
  const managerWork = join(RUN, testCase.name + '-work');
  const library = new Library({ dataDir: shelfDir });
  library.open();
  const engine = new NovelEngine({ engineDir, workDir: join(managerWork, 'engine') });
  const manager = new NovelFetches(engine, (file, metadata) => library.importFile(metadata, file), {
    workDir: managerWork, pageProbe: null,
  });
  const started = Date.now();
  let task: NovelTaskView | undefined;
  try {
    task = await waitTask(manager, manager.start(testCase.candidate).id, 12 * 60_000);
  } catch (error) {
    task = undefined;
    results.push({ case: testCase.name, source: testCase.candidate.source, error: (error as Error).message, seconds: (Date.now() - started) / 1000 });
    library.close();
    continue;
  }
  const validated = newestValidated(managerWork);
  const text = validated ? readFileSync(validated, 'utf8') : '';
  const books = library.list();
  results.push({
    case: testCase.name, source: testCase.candidate.source, url: testCase.candidate.url,
    state: task.state, catalogChapters: task.catalogChapters, downloadedChapters: task.downloadedChapters,
    issueCount: task.issueCount, issueCodes: [...new Set(task.issues.map((issue) => issue.code))],
    warningCount: task.warningCount, warningCodes: [...new Set(task.warnings.map((issue) => issue.code))],
    error: task.error ?? null, seconds: Math.round((Date.now() - started) / 1000),
    shelfBooks: books.map((book) => ({ title: book.title, author: book.author, chapters: book.identifiedChapters, chars: book.totalChars })),
    text: text ? analyze(text) : null,
  });
  console.log(JSON.stringify({ case: testCase.name, source: testCase.candidate.source.name, state: task.state, catalog: task.catalogChapters, downloaded: task.downloadedChapters, issues: [...new Set(task.issues.map((issue) => issue.code))], warnings: task.warningCount, seconds: Math.round((Date.now() - started) / 1000) }));
  library.close();
}

writeFileSync(join(OUT, 'source-research.json'), `${JSON.stringify({ date: new Date().toISOString(), cases: results }, null, 2)}\n`, 'utf8');
console.log('written', join(OUT, 'source-research.json'));
