/**
 * Author-only search smoke test (the "or author" half of the input path).
 *
 * Runs the production search with only an author name, checks that every
 * returned candidate is an author match, and validates the catalog of the
 * first candidate to prove the result is a real, openable book page. No
 * download, no shelf write.
 *
 * Usage: node --import tsx scripts/check-author-search.mts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NovelEngine } from '../src/novel-engine.ts';
import { NovelFetches } from '../src/novel-fetch.ts';
import { NOVEL_SOURCES } from '../src/novel-sources.ts';

const ENGINE_DIR = process.env.BOOKFISH_ENGINE_DIR
  ?? 'E:/zcdfy/Coopanion/data/home/companion/data/bookfish/novel-engine/versions/bookfish-runtime-1.12.0-bf1-win32-x64-mwa8n73a';
const AUTHORS = ['爱潜水的乌贼', '辰东', '耳根', '千山茶客', '卖报小郎君'];

const workDir = join(process.cwd(), 'output', `author-search-work-${Date.now()}`);
mkdirSync(workDir, { recursive: true });
const engine = new NovelEngine({ engineDir: ENGINE_DIR, workDir });
const fetches = new NovelFetches(engine, () => { throw new Error('importer must never run'); }, {
  workDir, sources: NOVEL_SOURCES, searchSourceIds: NOVEL_SOURCES.map((source) => source.id), maxTasks: 4,
});

const rows = [];
for (const author of AUTHORS) {
  const started = Date.now();
  const row: Record<string, unknown> = { author, ok: false, candidates: 0, sources: [], works: [], ms: 0 };
  try {
    const candidates = await fetches.search('', author);
    row.candidates = candidates.length;
    row.sources = [...new Set(candidates.map((candidate) => `${candidate.source.id}:${candidate.source.name}`))];
    row.works = [...new Set(candidates.map((candidate) => candidate.title))].slice(0, 12);
    const first = candidates[0];
    if (first) {
      const check = await fetches.checkCandidate(first);
      row.firstCandidate = { title: first.title, source: first.source.name, ok: check.ok, chapters: check.chapters, reason: check.reason ?? null,
        issues: check.issues.map((issue) => issue.code) };
      row.ok = candidates.every((candidate) => candidate.match === 'exact') && check.ok;
    }
  } catch (error) {
    row.error = (error as Error).message.slice(0, 500);
  }
  row.ms = Date.now() - started;
  rows.push(row);
  console.log(`${author}: 候选 ${row.candidates}，首本校验 ${(row.firstCandidate as { ok?: boolean } | undefined)?.ok ? 'PASS' : 'FAIL'}，用时 ${(row.ms / 1000).toFixed(1)}s`);
}

const outFile = join(process.cwd(), 'output', `author-search-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(outFile, `${JSON.stringify({ at: new Date().toISOString(), engine: engine.availability(), rows }, null, 2)}\n`, 'utf8');
console.log(`证据：${outFile}`);
process.exitCode = rows.every((row) => row.ok) ? 0 : 1;
