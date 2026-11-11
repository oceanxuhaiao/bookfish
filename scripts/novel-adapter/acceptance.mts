/**
 * Acceptance harness for the isolated so-novel adapter.
 *
 * Phase A proves that missing chapters, missing pages and mixed editions never
 * reach an isolated shelf. Phase B downloads one public-domain book with an
 * explicitly recorded edition (三国演义, 毛宗岗 120-chapter text) and imports it
 * through the extension's existing streaming import.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Library } from '../../src/library.ts';
import { FIXTURE_PORT, startFixtureServer, writeFixtureRules } from './fixture-server.mts';
import { NovelTaskError, SonovelAdapter, matchCandidate, resetIsolatedShelf } from './adapter.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '../..');
const OUT = join(PACKAGE_ROOT, 'output', 'novel-adapter');
mkdirSync(OUT, { recursive: true });

interface CaseReport {
  name: string;
  expected: string;
  taskState: string;
  issues: string[];
  shelfBooks: string[];
  passed: boolean;
  detail?: string;
  seconds: number;
}

function shelfBooks(shelfDir: string) {
  if (!existsSync(join(shelfDir, 'bookfish', 'library.json'))) return [];
  const library = new Library({ dataDir: shelfDir });
  library.open();
  try { return library.list().map((book) => ({ key: book.key, title: book.title, author: book.author, totalChars: book.totalChars, identifiedChapters: book.identifiedChapters })); }
  finally { library.close(); }
}

async function runControlled(adapter: SonovelAdapter, rulesFile: string): Promise<CaseReport[]> {
  const reports: CaseReport[] = [];
  const cases: Array<{ name: string; query: string; title: string; author: string; sourceId: number; expect: 'complete' | 'fail'; issue?: string }> = [
    { name: 'complete-3-chapters', query: '海边的信', title: '海边的信', author: '小鱼', sourceId: 1, expect: 'complete' },
    { name: 'missing-chapter', query: '断章书', title: '断章书', author: '小鱼', sourceId: 1, expect: 'fail', issue: 'missing_chapter' },
    { name: 'missing-last-page', query: '漏页书', title: '漏页书', author: '小鱼', sourceId: 1, expect: 'fail', issue: 'missing_page_marker' },
    { name: 'mixed-edition', query: '混版书', title: '混版书', author: '小鱼', sourceId: 1, expect: 'fail', issue: 'catalog_duplicate_number' },
    { name: 'complete-paginated-chapter', query: '分页书', title: '分页书', author: '小鱼', sourceId: 2, expect: 'complete' },
  ];
  for (const testCase of cases) {
    const started = Date.now();
    const shelf = join(OUT, 'shelf', testCase.name);
    resetIsolatedShelf(shelf);
    const candidates = await adapter.search(testCase.query, { sourceIds: [testCase.sourceId], rulesFile });
    const candidate = matchCandidate(candidates, { title: testCase.title, author: testCase.author });
    let task: Record<string, unknown> | null = null;
    let error: NovelTaskError | undefined;
    try {
      task = await adapter.fetch(candidate, { shelfDir: shelf, rulesFile, timeoutMs: 120_000 }) as unknown as Record<string, unknown>;
    } catch (caught) {
      error = caught as NovelTaskError;
      task = (error.task as unknown as Record<string, unknown>) ?? null;
    }
    const books = shelfBooks(shelf);
    const issues = (((task?.issues as Array<{ code: string }> | undefined) ?? []).map((item) => item.code));
    const passed = testCase.expect === 'complete'
      ? Boolean(task && task.state === 'complete' && books.length === 1)
      : Boolean(error && (task?.state === 'failed') && books.length === 0 && testCase.issue && issues.includes(testCase.issue));
    reports.push({
      name: testCase.name, expected: testCase.expect, taskState: String(task?.state ?? 'none'), issues,
      shelfBooks: books.map((book) => `${book.title}/${book.identifiedChapters}章`), passed,
      detail: error?.message ?? (task?.error as string | undefined), seconds: (Date.now() - started) / 1000,
    });
    console.log(`[controlled] ${testCase.name}: state=${task?.state} issues=${issues.join(',') || 'none'} shelf=${books.length} ${passed ? 'PASS' : 'FAIL'}`);
  }
  return reports;
}

async function runCancellation(adapter: SonovelAdapter, rulesFile: string): Promise<Record<string, unknown>> {
  const candidates = await adapter.search('海边的信', { sourceIds: [1], rulesFile });
  const candidate = matchCandidate(candidates, { title: '海边的信', author: '小鱼' });
  const shelf = join(OUT, 'shelf', 'cancelled-mid-fetch');
  resetIsolatedShelf(shelf);
  const controller = new AbortController();
  const pending = adapter.fetch(candidate, { shelfDir: shelf, rulesFile, signal: controller.signal, timeoutMs: 120_000 });
  const timer = setTimeout(() => controller.abort(), 900);
  try {
    await pending;
    throw new Error('cancelled task completed unexpectedly');
  } catch (error) {
    const taskError = error as NovelTaskError;
    assert.equal(taskError.code, 'cancelled');
    assert.equal(taskError.task?.state, 'cancelled');
    assert.equal(shelfBooks(shelf).length, 0);
    console.log(`[cancel] state=${taskError.task?.state} shelf=0`);
    return { state: taskError.task?.state, shelfBooks: 0 };
  } finally { clearTimeout(timer); }
}

async function findCandidate(adapter: SonovelAdapter, title: string, author: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const candidates = await adapter.search(title, { sourceIds: [8] });
      return matchCandidate(candidates, { title, author });
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
    }
  }
  throw lastError;
}

async function runReal(): Promise<{ report: Record<string, unknown>; books: ReturnType<typeof shelfBooks> }> {
  const adapter = new SonovelAdapter({ workDir: join(OUT, 'real-work') });
  const candidate = await findCandidate(adapter, '三国演义', '罗贯中');
  assert.equal(candidate.url, 'https://www.biquge365.net/book/08451/');
  const shelf = join(OUT, 'shelf', '三国演义-毛本120回');
  resetIsolatedShelf(shelf);
  const started = Date.now();
  const task = await adapter.fetch(candidate, { shelfDir: shelf, timeoutMs: 20 * 60_000 });
  const books = shelfBooks(shelf);
  assert.equal(task.state, 'complete');
  assert.equal(task.catalogChapters, 120);
  assert.equal(task.downloadedChapters, 120);
  assert.deepEqual(task.issues ?? [], []);
  assert.equal(books.length, 1);
  assert.equal(books[0]!.title, '三国演义');
  assert.equal(books[0]!.author, '罗贯中');
  assert.equal(books[0]!.identifiedChapters, 120);
  assert.ok(books[0]!.totalChars > 200_000, `expected full text, got ${books[0]!.totalChars} chars`);

  const library = new Library({ dataDir: shelf });
  library.open();
  let firstChapter = '';
  let lastChapter = '';
  try {
    const first = library.list()[0]!;
    const firstPage = library.reader({ bookKey: first.key, chapterOffset: 0 });
    const allChapters = firstPage.nextChapterOffset === null
      ? firstPage.chapters
      : [...firstPage.chapters, ...library.reader({ bookKey: first.key, chapterOffset: firstPage.nextChapterOffset }).chapters];
    const chapters = allChapters.filter((item) => /^第.+[回章节]/u.test(item.title));
    assert.equal(chapters.length, 120);
    assert.match(chapters[0]!.title, /第001回/u);
    assert.match(chapters[119]!.title, /第120回|第一百二十回/u);
    firstChapter = chapters[0]!.title;
    lastChapter = chapters[119]!.title;
    const firstText = library.reader({ bookKey: first.key, segment: chapters[0]!.segment }).segments.map((segment) => segment.text).join('');
    assert.match(firstText, /宴桃园豪杰三结义/u);
  } finally { library.close(); }

  const validated = join(task.workDir, 'validated.txt');
  const report = {
    book: '三国演义 / 罗贯中（毛宗岗 120 回本）',
    source: candidate.source,
    bookUrl: candidate.url,
    revision: candidate.revision,
    catalogChapters: task.catalogChapters,
    downloadedChapters: task.downloadedChapters,
    issues: task.issues ?? [],
    totalChars: books[0]!.totalChars,
    identifiedChapters: books[0]!.identifiedChapters,
    validatedBytes: statSync(validated).size,
    seconds: (Date.now() - started) / 1000,
    firstChapter,
    lastChapter,
    shelf: books,
  };
  console.log(`[real] 三国演义 complete: ${report.totalChars} chars, ${report.identifiedChapters} chapters, ${report.seconds.toFixed(1)}s`);
  return { report, books };
}

/** Real catalog evidence: a source listing the same book twice with two numbering schemes. */
async function runRealMixed(): Promise<Record<string, unknown>> {
  const adapter = new SonovelAdapter({ workDir: join(OUT, 'real-mixed-work') });
  const candidates = await adapter.search('西游记', { sourceIds: [8] });
  // Two same-author editions are returned; the 192-entry URL is the known mixed
  // catalog observed in the earlier comparison. Pin it explicitly.
  const candidate = candidates.find((item) => item.url.includes('/book/21551/'));
  if (!candidate) throw new Error('mixed-edition catalog was not returned by the source');
  return rejectCatalog(adapter, candidate, '西游记-混版目录', 'mixed', ['catalog_duplicate_number', 'catalog_duplicate_title', 'catalog_number_regression']);
}

/** Second real catalog: 101 entries for a 100-chapter novel, shifted after insertion. */
async function runRealDrift(): Promise<Record<string, unknown>> {
  const adapter = new SonovelAdapter({ workDir: join(OUT, 'real-drift-work') });
  const candidates = await adapter.search('西游记', { sourceIds: [8] });
  const candidate = candidates.find((item) => item.url.includes('/book/979471/'));
  if (!candidate) throw new Error('drifted catalog was not returned by the source');
  return rejectCatalog(adapter, candidate, '西游记-目录漂移', 'drift', ['catalog_number_order_mismatch', 'catalog_duplicate_number', 'catalog_order_gap', 'catalog_number_regression']);
}

async function rejectCatalog(adapter: SonovelAdapter, candidate: ReturnType<typeof matchCandidate>, label: string, kind: string, expected: string[]): Promise<Record<string, unknown>> {
  const shelf = join(OUT, 'shelf', label);
  resetIsolatedShelf(shelf);
  try {
    await adapter.fetch(candidate, { shelfDir: shelf, timeoutMs: 120_000 });
    throw new Error(`${kind} catalog was accepted unexpectedly`);
  } catch (error) {
    const taskError = error as NovelTaskError;
    const books = shelfBooks(shelf);
    const issues = (taskError.issues ?? []).map((item) => item.code);
    const issueCounts = Object.fromEntries([...new Set(issues)].map((code) => [code, issues.filter((item) => item === code).length]));
    assert.equal(taskError.code, 'failed');
    assert.equal(books.length, 0);
    assert.ok(issues.some((code) => expected.includes(code)), `expected one of ${expected.join(',')}, got ${issues.join(',')}`);
    console.log(`[${kind}] rejected before download: ${JSON.stringify(issueCounts)}`);
    return { url: candidate.url, catalogChapters: taskError.task?.catalogChapters, issueCounts, shelfBooks: books.length, state: taskError.task?.state };
  }
}

async function main() {
  const server = await startFixtureServer(FIXTURE_PORT);
  const rulesFile = writeFixtureRules(FIXTURE_PORT, join(OUT, 'fixture-rules.json'));
  const adapter = new SonovelAdapter({ workDir: join(OUT, 'controlled-work') });
  const startedAt = new Date().toISOString();
  try {
    const controlled = await runControlled(adapter, rulesFile);
    const cancellation = await runCancellation(adapter, rulesFile);
    const ambiguity = await (async () => {
      const results = await adapter.search('海边的信', { sourceIds: [1], rulesFile });
      const correct = matchCandidate(results, { title: '海边的信', author: '小鱼' });
      const sameTitleAuthors = results.filter((item) => item.title === '海边的信').map((item) => item.author).sort();
      assert.equal(correct.url, 'http://127.0.0.1:18870/plain/ok/');
      assert.throws(() => matchCandidate(results, { title: '海边的信', author: '查无此人' }));
      console.log(`[search] same-title authors=${sameTitleAuthors.join('/')} selected=${correct.author}`);
      return { sameTitleAuthors, selected: correct.author, selectedUrl: correct.url };
    })();
    const realMixed = process.env.NOVEL_ACCEPTANCE_CONTROLLED_ONLY ? { skipped: true } : await runRealMixed();
    const realDrift = process.env.NOVEL_ACCEPTANCE_CONTROLLED_ONLY ? { skipped: true } : await runRealDrift();
    const real = process.env.NOVEL_ACCEPTANCE_CONTROLLED_ONLY ? { report: { skipped: true }, books: [] } : await runReal();
    const report = {
      startedAt,
      finishedAt: new Date().toISOString(),
      soNovel: readFileSync(join(PACKAGE_ROOT, 'output', 'novel-engine-comparison', 'environment.json'), 'utf8').trim(),
      controlled,
      cancellation,
      ambiguity,
      realMixed,
      realDrift,
      real: real.report,
      liveInstanceTouched: false,
    };
    writeFileSync(join(OUT, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    const failed = controlled.filter((item) => !item.passed);
    console.log(`acceptance written; controlled failures=${failed.length}; shelf=${real.report.identifiedChapters} chapters`);
    if (failed.length) process.exitCode = 1;
  } finally {
    server.close();
  }
}

await main();
