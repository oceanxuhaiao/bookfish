/**
 * Production-path acceptance for fetch-by-title.
 *
 * Uses the same NovelEngine + NovelFetches code installed into the World, but
 * with an isolated Library shelf and an isolated work directory. It never
 * touches the live Coopanion data.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library } from '../../src/library.ts';
import { NovelEngine } from '../../src/novel-engine.ts';
import { NovelFetches, type NovelTaskView } from '../../src/novel-fetch.ts';
import { SourcePageProbe } from '../../src/novel-probe.ts';
import { matchCandidate, type NovelSearchCandidate } from '../../src/novel-match.ts';
import type { NovelSourceSpec } from '../../src/novel-sources.ts';
import { FIXTURE_PORT, startFixtureServer, writeFixtureRules } from './fixture-server.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '../..');
const RESEARCH = process.env.SONOVEL_RESEARCH_ROOT ?? resolve(PACKAGE_ROOT, '../../research/novel-fetch-20261109');
const RUNTIME = join(RESEARCH, 'sonovel-runtime', 'SoNovel');
const OUT = join(PACKAGE_ROOT, 'output', 'novel-adapter', 'production');
mkdirSync(OUT, { recursive: true });

async function waitTask(manager: NovelFetches, id: string, timeoutMs = 15 * 60_000): Promise<NovelTaskView> {
  const started = Date.now();
  let lastState = '';
  while (Date.now() - started < timeoutMs) {
    const task = manager.get(id);
    if (task.state !== lastState) { lastState = task.state; console.log(`  task ${task.state} ${task.percent}% ${task.downloadedChapters}/${task.catalogChapters} ${task.error ?? ''}`); }
    if (['complete', 'failed', 'cancelled'].includes(task.state)) return task;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error('Timed out waiting for novel task');
}

function openShelf(name: string) {
  const dir = join(OUT, 'shelf', name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  const library = new Library({ dataDir: dir });
  library.open();
  return { dir, library };
}

async function controlled(engine: NovelEngine, rulesFile: string) {
  const fixtureSources: NovelSourceSpec[] = [
    { id: 1, name: 'fixture-plain', host: '127.0.0.1', bookPath: /^\/plain\/[a-z-]+\/$/u, probe: null },
    { id: 2, name: 'fixture-paged', host: '127.0.0.1', bookPath: /^\/paged\/[a-z-]+\/$/u, probe: null },
  ];
  const cases = [
    { name: 'complete', title: '海边的信', author: '小鱼', sourceId: 1, expect: 'complete' },
    { name: 'missing-chapter', title: '断章书', author: '小鱼', sourceId: 1, expect: 'failed', issue: 'missing_chapter' },
    { name: 'missing-page', title: '漏页书', author: '小鱼', sourceId: 1, expect: 'failed', issue: 'missing_page_marker' },
    { name: 'mixed', title: '混版书', author: '小鱼', sourceId: 1, expect: 'failed', issue: 'catalog_duplicate_number' },
    { name: 'paged-complete', title: '分页书', author: '小鱼', sourceId: 2, expect: 'complete' },
  ];
  const results: Array<Record<string, unknown>> = [];
  const fixtureEngine = new NovelEngine({ engineDir: RUNTIME, workDir: join(OUT, 'work-controlled'), rulesFile });
  for (const testCase of cases) {
    const { dir, library } = openShelf(testCase.name);
    const manager = new NovelFetches(fixtureEngine, (file, metadata) => library.importFile(metadata, file), {
      workDir: join(OUT, 'manager-controlled', testCase.name),
      sources: fixtureSources, searchSourceIds: [1, 2], allowedPorts: [String(FIXTURE_PORT)], pageProbe: null,
    });
    const candidates = await manager.search(testCase.title, testCase.author);
    const candidate = candidates.find((item) => item.match === 'exact')!;
    assert.ok(candidate, `${testCase.name}: no exact candidate`);
    const task = await waitTask(manager, manager.start(candidate).id, 180_000);
    const books = library.list();
    const pass = testCase.expect === 'complete' ? task.state === 'complete' && books.length === 1 :
      task.state === 'failed' && books.length === 0 && (!testCase.issue || task.issues.some((issue) => issue.code === testCase.issue));
    console.log(`${pass ? 'PASS' : 'FAIL'} controlled ${testCase.name}: ${task.state} issues=${task.issues.map((issue) => issue.code).join(',')} shelf=${books.length}`);
    results.push({ name: testCase.name, state: task.state, issues: task.issues.map((issue) => issue.code), shelf: books.map((book) => `${book.title}/${book.identifiedChapters}`), pass });
    library.close(); rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

async function realFullBook() {
  const engine = new NovelEngine({ engineDir: RUNTIME, workDir: join(OUT, 'work-real') });
  const { dir, library } = openShelf('三国演义-毛本120回');
  const manager = new NovelFetches(engine, (file, metadata) => library.importFile(metadata, file), {
    workDir: join(OUT, 'manager-real'), pageProbe: new SourcePageProbe(),
  });
  const candidates = await manager.search('三国演义', '罗贯中');
  const nonBiquge = candidates.find((candidate) => candidate.source.id === 9 && candidate.match === 'exact');
  const candidate = nonBiquge ?? matchCandidate(candidates.map(({ match: _match, ...item }) => item), { title: '三国演义', author: '罗贯中' });
  const started = Date.now();
  const task = await waitTask(manager, manager.start(candidate).id);
  const books = library.list();
  assert.equal(task.state, 'complete');
  assert.deepEqual(task.issues, []);
  assert.equal(task.catalogChapters, 120);
  assert.equal(task.downloadedChapters, 120);
  assert.equal(books.length, 1);
  assert.equal(books[0]!.identifiedChapters, 120);
  assert.ok(books[0]!.totalChars > 200_000);
  const first = library.reader({ bookKey: books[0]!.key, chapterOffset: 1 });
  assert.match(first.chapters[0]!.title, /第0*1回|第一回/u);
  const report = {
    book: `三国演义 / 罗贯中（毛宗岗 120 回本，${candidate.source.name}）`, url: candidate.url, revision: candidate.revision,
    source: candidate.source,
    state: task.state, catalogChapters: task.catalogChapters, downloadedChapters: task.downloadedChapters,
    totalChars: books[0]!.totalChars, identifiedChapters: books[0]!.identifiedChapters,
    issues: task.issues, seconds: (Date.now() - started) / 1000,
    pageProbe: `${candidate.source.name}-source-pages`,
  };
  console.log(`PASS real full book: ${report.identifiedChapters} chapters, ${report.totalChars} chars, ${report.seconds.toFixed(1)}s`);
  library.close();
  return { report, shelf: dir };
}

async function realMixed() {
  const engine = new NovelEngine({ engineDir: RUNTIME, workDir: join(OUT, 'work-mixed') });
  const manager = new NovelFetches(engine, () => { throw new Error('must not import mixed catalog'); }, { workDir: join(OUT, 'manager-mixed') });
  const candidates = await manager.search('西游记', '吴承恩');
  const mixed = candidates.find((item) => item.url.includes('/book/21551/'));
  assert.ok(mixed, 'mixed catalog candidate missing');
  const task = await waitTask(manager, manager.start(mixed).id, 120_000);
  assert.equal(task.state, 'failed');
  assert.equal(task.downloadedChapters, 0);
  assert.ok(task.issues.some((issue) => ['catalog_duplicate_number', 'catalog_number_order_mismatch', 'catalog_number_regression'].includes(issue.code)));
  console.log(`PASS real mixed catalog rejected before download: ${JSON.stringify([...new Set(task.issues.map((issue) => issue.code))])}`);
  return { url: mixed.url, catalogChapters: task.catalogChapters, issues: [...new Set(task.issues.map((issue) => issue.code))], downloadedChapters: task.downloadedChapters };
}

async function main() {
  const startedAt = new Date().toISOString();
  const server = await startFixtureServer(FIXTURE_PORT);
  const rulesFile = writeFixtureRules(FIXTURE_PORT, join(OUT, 'fixture-rules.json'));
  try {
    const controlledResults = await controlled(new NovelEngine({ engineDir: RUNTIME, workDir: join(OUT, 'work-controlled'), rulesFile }), rulesFile);
    if (process.env.PRODUCTION_ACCEPTANCE_FIXTURE_ONLY) {
      writeFileSync(join(OUT, 'acceptance.json'), `${JSON.stringify({ startedAt, fixtureOnly: true, controlled: controlledResults }, null, 2)}\n`);
      console.log('fixture-only acceptance written');
      return;
    }
    const mixed = await realMixed();
    const real = await realFullBook();
    const report = { startedAt, finishedAt: new Date().toISOString(), controlled: controlledResults, realMixed: mixed, real: real.report, liveInstanceTouched: false };
    writeFileSync(join(OUT, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log('production acceptance written');
  } finally { server.close(); }
}

await main();
