import { join } from 'node:path';
import { NovelEngine } from '../src/novel-engine.ts';
import { chapterNumberOf, isAnnouncementTitle } from '../src/novel-integrity.ts';
const engine = new NovelEngine({ engineDir: 'E:/zcdfy/Coopanion/data/home/companion/data/bookfish/novel-engine/versions/bookfish-runtime-1.12.0-bf1-win32-x64-mwa8n73a', workDir: join(process.cwd(), 'output', 'inspect2-work') });
const catalog = await engine.toc('http://www.xbiquwk.com/172_172618/', { timeoutMs: 120000 });
const left = catalog.filter((c) => chapterNumberOf(c.title) === null && !isAnnouncementTitle(c.title));
console.log('unnumbered kept:', left.length);
for (const c of left) console.log(c.order + '\t' + c.title);
