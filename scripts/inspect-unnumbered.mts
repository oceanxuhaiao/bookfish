/** List catalog entries that carry no chapter number, to design the
 * announcement filter against real data. Read-only. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NovelEngine } from '../src/novel-engine.ts';
import { chapterNumberOf } from '../src/novel-integrity.ts';

const engine = new NovelEngine({
  engineDir: 'E:/zcdfy/Coopanion/data/home/companion/data/bookfish/novel-engine/versions/bookfish-runtime-1.12.0-bf1-win32-x64-mwa8n73a',
  workDir: join(process.cwd(), 'output/toc-inspect-work'),
});
const targets = [
  { title: '玄鉴仙族', url: 'http://www.xbiquwk.com/172_172618/' },
  { title: '赘婿', url: 'http://www.xbiquwk.com/2_2386/' },
  { title: '轮回乐园', url: 'http://www.xbiquwk.com/40_40174/' },
];
const out: Record<string, unknown> = {};
for (const target of targets) {
  const catalog = await engine.toc(target.url, { timeoutMs: 120_000 });
  const unnumbered = catalog.filter((chapter) => chapterNumberOf(chapter.title) === null).map((chapter) => `${chapter.order}\t${chapter.title}`);
  out[target.title] = { count: catalog.length, unnumberedCount: unnumbered.length, unnumbered: unnumbered.slice(0, 120) };
  console.log(`${target.title}: ${catalog.length} chapters, ${unnumbered.length} unnumbered`);
}
writeFileSync(join(process.cwd(), 'output', 'toc-unnumbered.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
