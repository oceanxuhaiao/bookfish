import { join } from 'node:path';
import { NovelEngine } from '../src/novel-engine.ts';
import { assessNovelDownload, isAnnouncementTitle } from '../src/novel-integrity.ts';

const engine = new NovelEngine({
  engineDir: 'E:/zcdfy/Coopanion/data/home/companion/data/bookfish/novel-engine/versions/bookfish-runtime-1.12.0-bf1-win32-x64-mwa8n73a',
  workDir: join(process.cwd(), 'output', 'mixed-work'),
});
const catalog = await engine.toc('http://www.xbiquwk.com/3_3746/', { timeoutMs: 120_000 });
const body = catalog.filter((chapter) => !isAnnouncementTitle(chapter.title));

function copy(label: string, offset: number) {
  return body.map((chapter, index) => ({ order: offset + index + 1, title: chapter.title, url: `https://mirror.test/${label}/${index + 1}.html` }));
}

for (const copies of [1, 2, 3]) {
  const entries = Array.from({ length: copies }, (_, index) => copy(`c${index}`, index * body.length)).flat();
  const result = assessNovelDownload({
    book: { title: '璇＄涔嬩富', author: '鐖辨綔姘寸殑涔岃醇', sourceId: 1, sourceName: 'test', bookUrl: 'https://mirror.test/book' },
    catalog: entries, files: [], catalogOnly: true,
  });
  const codes = [...new Set(result.issues.map((item) => item.code))];
  console.log(`copies=${copies} chapters=${entries.length} complete=${result.complete} issues=${result.issues.length} codes=${codes.join(',')} warnings=${[...new Set(result.warnings.map((item) => item.code))].join(',')}`);
}

