import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NovelEngine } from '../src/novel-engine.ts';
import { assessNovelDownload } from '../src/novel-integrity.ts';
const [dir, url, sourceId, name] = process.argv.slice(2);
const engine = new NovelEngine({ engineDir: 'E:/zcdfy/Coopanion/data/home/companion/data/bookfish/novel-engine/versions/bookfish-runtime-1.12.0-bf1-win32-x64-mwa8n73a', workDir: join(process.cwd(), 'output', 'inspect-work') });
const catalog = await engine.toc(url!, { timeoutMs: 120000 });
const files = [];
for (const path of readdirSync(dir!, { recursive: true, encoding: 'utf8' })) {
  const base = String(path).split(/[\\/]/u).pop() ?? '';
  const m = base.match(/^(\d+)_(.*)\.txt$/u);
  if (!m) continue;
  files.push({ order: Number(m[1]), title: m[2], text: readFileSync(join(dir!, String(path)), 'utf8') });
}
const result = assessNovelDownload({ book: { title: '大奉打更人', author: '卖报小郎君', sourceId: Number(sourceId), sourceName: name, bookUrl: url }, catalog, files });
const codes = {}; for (const i of result.issues) codes[i.code] = (codes[i.code] ?? 0) + 1;
console.log(JSON.stringify({ catalog: catalog.length, files: files.length, complete: result.complete, issues: result.issues.length, codes, sample: result.issues.slice(0, 5).map(i => i.message) }, null, 2));
