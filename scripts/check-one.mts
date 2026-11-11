/** Validate one title/author through the same search + catalog preflight path.
 * When the query has no exact match it prints the full-title hints and then
 * retries with the closest hint, mirroring what the panel offers the user.
 * Usage: node --import tsx scripts/check-one.mts "书名" [作者] */
import { join } from 'node:path';
import { NovelEngine } from '../src/novel-engine.ts';
import { NovelFetches } from '../src/novel-fetch.ts';
import { NOVEL_SOURCES } from '../src/novel-sources.ts';

const [title, author = ''] = process.argv.slice(2);
if (!title) throw new Error('title required');
const workDir = join(process.cwd(), 'output', `check-one-work-${Date.now()}`);
const engine = new NovelEngine({
  engineDir: process.env.BOOKFISH_ENGINE_DIR
    ?? 'E:/zcdfy/Coopanion/data/home/companion/data/bookfish/novel-engine/versions/bookfish-runtime-1.12.0-bf1-win32-x64-mwa8n73a',
  workDir,
});
const fetches = new NovelFetches(engine, () => { throw new Error('no importer'); }, {
  workDir, sources: NOVEL_SOURCES, searchSourceIds: NOVEL_SOURCES.map((source) => source.id), maxTasks: 2,
});

async function run(queryTitle: string, queryAuthor: string, quiet = false) {
  const { candidates, suggestions } = await fetches.searchDetailed(queryTitle, queryAuthor);
  if (!quiet) {
    console.log(`候选 ${candidates.length}：${candidates.map((candidate) => `${candidate.source.name}《${candidate.title}》${candidate.author}`).join(' | ')}`);
    if (suggestions.length) console.log(`提示：${suggestions.map((item) => `《${item.title}》${item.author}（${item.sources} 源）`).join(' | ')}`);
  }
  return { candidates, suggestions };
}

const first = await run(title, author);
const exact = first.candidates.filter((candidate) => candidate.match === 'exact');
const wantedAuthor = author.replace(/\s+/gu, '');
const hint = exact.length
  ? undefined
  : (first.suggestions.find((item) => item.author.replace(/\s+/gu, '') === wantedAuthor) ?? first.suggestions[0]);
const final = hint ? await run(hint.title, hint.author) : first;
for (const candidate of final.candidates.filter((entry) => entry.match === 'exact').slice(0, 4)) {
  const check = await fetches.checkCandidate(candidate);
  console.log(`${hint ? '[按提示] ' : ''}${candidate.source.name} ${candidate.url} -> ${check.ok ? 'PASS' : 'FAIL'} ${check.chapters} 章 ${check.reason ?? ''} ${check.issues.map((issue) => issue.code).join(',')}`);
}
