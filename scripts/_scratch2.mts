import { assessNovelDownload, isAnnouncementTitle, type CatalogChapter } from '../src/novel-integrity.ts';
const book = { title: '海边的信', author: '小鱼', sourceId: 1, sourceName: '测试书源', bookUrl: 'http://127.0.0.1:18870/plain/ok/' };
const longBody = '海风吹过码头，小鱼从邮筒里取出一封信。信封上的字迹很熟悉，她坐在石阶上读完了第一行。'.repeat(3);
const chapter = (order, title) => ({ order, title, text: `${title}\n\n　　${longBody}\n` });
const withNotes: CatalogChapter[] = [
  { order: 1, title: '第1章 海边来信', url: 'http://127.0.0.1:18870/plain/ok/c1.html' },
  { order: 2, title: '上架感言', url: 'http://127.0.0.1:18870/plain/ok/note.html' },
  { order: 3, title: '第2章 海边来信', url: 'http://127.0.0.1:18870/plain/ok/c2.html' },
];
console.log('predicate', isAnnouncementTitle('上架感言'));
const result = assessNovelDownload({ book, catalog: withNotes, files: [chapter(1, '第1章 海边来信'), chapter(3, '第2章 海边来信')] });
console.log(JSON.stringify({ complete: result.complete, issues: result.issues, warnings: result.warnings }, null, 2));
