/** Validate one title/author through the same search + catalog preflight path.
 * Usage: node --import tsx scripts/check-one.mts "书名" "作者" */
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
const candidates = await fetches.search(title, author);
console.log(`候选 ${candidates.length}：${candidates.map((candidate) => `${candidate.source.name}《${candidate.title}》${candidate.author}`).join(' | ')}`);
for (const candidate of candidates.filter((entry) => entry.match === 'exact').slice(0, 4)) {
  const check = await fetches.checkCandidate(candidate);
  console.log(`${candidate.source.name} ${candidate.url} -> ${check.ok ? 'PASS' : 'FAIL'} ${check.chapters} 章 ${check.reason ?? ''} ${check.issues.map((issue) => issue.code).join(',')}`);
}
