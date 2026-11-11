import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NovelEngine } from '../src/novel-engine.ts';
import { assessNovelDownload, isAnnouncementTitle } from '../src/novel-integrity.ts';

const dir = process.argv[2]!;
const engine = new NovelEngine({
  engineDir: 'E:/zcdfy/Coopanion/data/home/companion/data/bookfish/novel-engine/versions/bookfish-runtime-1.12.0-bf1-win32-x64-mwa8n73a',
  workDir: join(process.cwd(), 'output', 'inspect-work'),
});
const catalog = await engine.toc('http://www.xbiquwk.com/62_62245/', { timeoutMs: 120_000 });
const files: Array<{ order: number; title: string; text: string }> = [];
for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
  const base = String(name).split(/[\\/]/u).pop() ?? '';
  const match = base.match(/^(\d+)_(.*)\.txt$/u);
  if (!match) continue;
  files.push({ order: Number(match[1]), title: match[2]!, text: readFileSync(join(dir, String(name)), 'utf8') });
}
files.sort((a, b) => a.order - b.order);
const result = assessNovelDownload({
  book: { title: '大奉打更人', author: '卖报小郎君', sourceId: 5, sourceName: '笔尖中文', bookUrl: 'http://www.xbiquwk.com/62_62245/' },
  catalog, files,
});
const codes: Record<string, number> = {};
for (const issue of result.issues) codes[issue.code] = (codes[issue.code] ?? 0) + 1;
console.log(JSON.stringify({
  catalog: catalog.length, files: files.length,
  announcements: catalog.filter((chapter) => isAnnouncementTitle(chapter.title)).length,
  complete: result.complete, issues: result.issues.length, codes,
  sample: result.issues.slice(0, 8).map((issue) => issue.message),
  warnings: result.warnings.slice(0, 8).map((warning) => warning.message),
  chapters: result.chapters.length, totalChars: result.totalChars,
}, null, 2));
