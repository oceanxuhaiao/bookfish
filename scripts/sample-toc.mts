/** Sample catalogs around the chapters that failed the gate, to tell a source
 * TOC defect from an over-strict check. Read-only: one toc call per book. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NovelEngine } from '../src/novel-engine.ts';

const ENGINE_DIR = 'E:/zcdfy/Coopanion/data/home/companion/data/bookfish/novel-engine/versions/bookfish-runtime-1.12.0-bf1-win32-x64-mwa8n73a';
const engine = new NovelEngine({ engineDir: ENGINE_DIR, workDir: join(process.cwd(), 'output/toc-sample-work') });
const targets = [
  { title: '轮回乐园', url: 'http://www.xbiquwk.com/40_40174/' },
  { title: '玄鉴仙族', url: 'http://www.xbiquwk.com/172_172618/' },
  { title: '赘婿', url: 'http://www.xbiquwk.com/2_2386/' },
];
const out: Record<string, unknown> = {};
for (const target of targets) {
  const catalog = await engine.toc(target.url, { timeoutMs: 120_000 });
  const rows = catalog.map((chapter) => `${chapter.order}\t${chapter.title}`);
  out[target.title] = {
    count: catalog.length,
    first: rows.slice(0, 6),
    around300: rows.slice(295, 310),
    around1450: rows.slice(1445, 1460),
    around4000: rows.slice(3995, 4010),
    last: rows.slice(-6),
    volumeMarkers: catalog.filter((chapter) => /[卷部]$|第[一二三四五六七八九十]+卷/u.test(chapter.title)).slice(0, 8).map((chapter) => chapter.title),
  };
  console.log(`${target.title}: ${catalog.length} chapters`);
}
writeFileSync('output/toc-sample.json', `${JSON.stringify(out, null, 2)}\n`, 'utf8');
