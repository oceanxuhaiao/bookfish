/** Show the catalog gate verdict for one source URL, including warnings and
 * how many entries the announcement filter skipped. Read-only. */
import { join } from 'node:path';
import { NovelEngine } from '../src/novel-engine.ts';
import { assessNovelDownload, isAnnouncementTitle } from '../src/novel-integrity.ts';

const [title, author, url] = process.argv.slice(2);
if (!title || !author || !url) throw new Error('usage: <title> <author> <bookUrl>');
const engine = new NovelEngine({
  engineDir: process.env.BOOKFISH_ENGINE_DIR
    ?? 'E:/zcdfy/Coopanion/data/home/companion/data/bookfish/novel-engine/versions/bookfish-runtime-1.12.0-bf1-win32-x64-mwa8n73a',
  workDir: join(process.cwd(), 'output', `verdict-work-${Date.now()}`),
});
const catalog = await engine.toc(url, { timeoutMs: 120_000 });
const announcements = catalog.filter((chapter) => isAnnouncementTitle(chapter.title));
const result = assessNovelDownload({
  book: { title, author, sourceId: 5, sourceName: 'probe', bookUrl: url },
  catalog, files: [], catalogOnly: true,
});
console.log(JSON.stringify({
  chapters: catalog.length,
  skippedAnnouncements: announcements.length,
  skippedSample: announcements.slice(0, 6).map((chapter) => `${chapter.order}\t${chapter.title}`),
  complete: result.complete,
  issues: result.issues,
  warnings: result.warnings,
}, null, 2));
