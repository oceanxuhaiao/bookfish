import { describe, expect, it } from 'vitest';
import { assessNovelDownload, chapterNumberOf, composeValidatedText, isAnnouncementTitle, type CatalogChapter, type DownloadChapterFile } from '../src/novel-integrity.ts';

const book = { title: '海边的信', author: '小鱼', sourceId: 1, sourceName: '测试书源', bookUrl: 'http://127.0.0.1:18870/plain/ok/' };

function chapter(order: number, title: string, body: string): DownloadChapterFile {
  return { order, title, text: `${title}\n\n　　${body}\n` };
}

const longBody = '海风吹过码头，小鱼从邮筒里取出一封信。信封上的字迹很熟悉，她坐在石阶上读完了第一行。'.repeat(3);

function catalog(count = 3): CatalogChapter[] {
  return Array.from({ length: count }, (_, index) => ({
    order: index + 1,
    title: `第${index + 1}章 海边来信`,
    url: `http://127.0.0.1:18870/plain/ok/c${index + 1}.html`,
  }));
}

function files(count = 3): DownloadChapterFile[] {
  return catalog(count).map((item) => chapter(item.order, item.title, longBody));
}

describe('chapter number parsing', () => {
  it('reads Arabic and Chinese chapter numbers', () => {
    expect(chapterNumberOf('第001回 宴桃园豪杰三结义')).toBe(1);
    expect(chapterNumberOf('第一百二十回 荐杜预老将献新谋')).toBe(120);
    expect(chapterNumberOf('第九十九回 九九数完魔灭尽')).toBe(99);
    expect(chapterNumberOf('第十二节')).toBe(12);
    expect(chapterNumberOf('序章')).toBeNull();
  });

  it('reads the chapter number after a volume prefix and ignores a bare volume heading', () => {
    expect(chapterNumberOf('第十卷 魔界之战 第一千七百六十三章 魔影再现')).toBe(1763);
    expect(chapterNumberOf('第三卷 第一百九十三章 敌友之分')).toBe(193);
    expect(chapterNumberOf('第一卷')).toBeNull();
  });
});

describe('announcement titles', () => {
  it('recognizes non-story entries and keeps structural ones', () => {
    for (const title of ['请假一天。', '感谢', '结卷感言。', '中奖名单', '新年快乐+番外抽奖！', '上架感言+废蚊', '早点休息', '番外说明', '꒦ິ^꒦ິ', '！注意！', 'ps 时间微调']) {
      expect(isAnnouncementTitle(title)).toBe(true);
    }
    for (const title of ['楔子 繁华过眼', '序章', '番外 雪夜', '大结局', '第12章 感谢', '第100章 请假', '第一一〇章 围城', '第一二〇章 感谢']) {
      expect(isAnnouncementTitle(title)).toBe(false);
    }
  });
});

describe('novel download integrity', () => {
  it('accepts one complete contiguous edition', () => {
    const result = assessNovelDownload({ book, catalog: catalog(), files: files() });
    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.chapters.map((item) => item.order)).toEqual([1, 2, 3]);
    expect(result.totalChars).toBeGreaterThan(100);
  });

  it('rejects a missing chapter even though the engine produced a merged file', () => {
    const result = assessNovelDownload({ book, catalog: catalog(), files: files().filter((file) => file.order !== 2) });
    expect(result.complete).toBe(false);
    expect(result.issues.map((item) => item.code)).toContain('missing_chapter');
    expect(result.chapters).toEqual([]);
  });

  it('rejects a paginated chapter that only returned its first page', () => {
    const broken = files();
    broken[1] = { ...broken[1]!, text: `${broken[1]!.title}\n\n　　${longBody}\n　　本章未完，点击下一页继续阅读` };
    const result = assessNovelDownload({ book, catalog: catalog(), files: broken });
    expect(result.complete).toBe(false);
    expect(result.issues.map((item) => item.code)).toContain('missing_page_marker');
  });

  it('ignores a lone punctuation line left by the source template', () => {
    const broken = files();
    broken[1] = { ...broken[1]!, text: `${broken[1]!.title}\n\n　　${longBody}\n　　;` };
    const result = assessNovelDownload({ book, catalog: catalog(), files: broken });
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('strips trailing source ad lines before checking the tail', () => {
    const broken = files();
    broken[1] = { ...broken[1]!, text: `${broken[1]!.title}\n\n　　${longBody}\n　　先定个小目标，比如1秒记住：书客居手机版阅读网址：` };
    const result = assessNovelDownload({ book, catalog: catalog(), files: broken });
    expect(result.complete).toBe(true);
    expect(result.chapters[1]!.text).not.toContain('书客居');
  });

  it('does not treat a closing 未完待续 author note as a page marker', () => {
    const broken = files();
    broken[1] = { ...broken[1]!, text: `${broken[1]!.title}\n\n　　${longBody}\n　　（未完待续。。）` };
    const result = assessNovelDownload({ book, catalog: catalog(), files: broken });
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('rejects a page-1 footer even when the site uses parentheses', () => {
    const broken = files();
    broken[1] = { ...broken[1]!, text: `${broken[1]!.title}\n\n　　${longBody}\n　　第(1/3)页` };
    const result = assessNovelDownload({ book, catalog: catalog(), files: broken });
    expect(result.complete).toBe(false);
    expect(result.issues.map((item) => item.code)).toContain('missing_page_marker');
  });

  it('strips a trailing “正在手打中” source placeholder instead of rejecting the chapter', () => {
    const broken = files();
    broken[1] = { ...broken[1]!, text: `${broken[1]!.title}\n\n　　${longBody}\n　　正在手打中，客官请稍等片刻，内容更新后，需要重新刷新页面。` };
    const result = assessNovelDownload({ book, catalog: catalog(), files: broken });
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('keeps a replacement character in the catalog title as a warning, not a mixed-edition rejection', () => {
    const cat = catalog(); cat[1] = { ...cat[1]!, title: '第2章 海边来�' };
    const result = assessNovelDownload({ book, catalog: cat, files: files() });
    expect(result.complete).toBe(true);
    expect(result.warnings.map((item) => item.code)).toContain('catalog_title_encoding');
  });

  it('strips trailing copied JavaScript instead of treating it as story text', () => {
    const broken = files();
    broken[1] = { ...broken[1]!, text: `${broken[1]!.title}\n\n　　${longBody}\n　　htmlPosition(elFix);\n　　});` };
    const result = assessNovelDownload({ book, catalog: catalog(), files: broken });
    expect(result.complete).toBe(true);
  });

  it('keeps one empty source chapter as a warning for a book of at least 20 chapters', () => {
    const cat = catalog(20), broken = files(20);
    broken[4] = { ...broken[4]!, text: `${broken[4]!.title}\n\n` };
    const result = assessNovelDownload({ book, catalog: cat, files: broken });
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.warnings.map((item) => item.code)).toContain('source_empty_chapter');
    expect(result.chapters).toHaveLength(20);
    expect(composeValidatedText(book, result.chapters)).toContain(broken[4]!.title);
  });

  it('rejects two empty chapters even in a long book', () => {
    const cat = catalog(20), broken = files(20);
    broken[4] = { ...broken[4]!, text: `${broken[4]!.title}\n\n` };
    broken[5] = { ...broken[5]!, text: `${broken[5]!.title}\n\n` };
    const result = assessNovelDownload({ book, catalog: cat, files: broken });
    expect(result.complete).toBe(false);
    expect(result.issues.map((item) => item.code).filter((code) => code === 'empty_chapter')).toHaveLength(2);
  });

  it('still rejects one empty chapter in a short book', () => {
    const broken = files();
    broken[1] = { ...broken[1]!, text: `${broken[1]!.title}\n\n` };
    const result = assessNovelDownload({ book, catalog: catalog(), files: broken });
    expect(result.complete).toBe(false);
    expect(result.issues.map((item) => item.code)).toContain('empty_chapter');
  });

  it('keeps one isolated source-side cut as a recorded warning, not a rejection', () => {
    const broken = files();
    broken[2] = { ...broken[2]!, text: `${broken[2]!.title}\n\n　　${longBody}，` };
    const result = assessNovelDownload({ book, catalog: catalog(), files: broken });
    expect(result.complete).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.warnings.map((item) => item.code)).toContain('truncated_chapter_tail');
  });

  it('still rejects two or more cut-off chapters', () => {
    const broken = files();
    broken[1] = { ...broken[1]!, text: `${broken[1]!.title}\n\n　　${longBody}，` };
    broken[2] = { ...broken[2]!, text: `${broken[2]!.title}\n\n　　${longBody}：` };
    const result = assessNovelDownload({ book, catalog: catalog(), files: broken });
    expect(result.complete).toBe(false);
    expect(result.issues.map((item) => item.code).filter((code) => code === 'truncated_chapter_tail')).toHaveLength(2);
  });

  it('rejects mixed editions with duplicate chapter numbers', () => {
    const numerals = ['一', '二', '三', '四', '五', '六'];
    const mixed: CatalogChapter[] = [
      ...catalog(6),
      ...numerals.map((numeral, index) => ({
        order: index + 7,
        title: `第${numeral}回 另一个版本`,
        url: `http://127.0.0.1:18870/plain/mixed/x${index + 1}.html`,
      })),
    ];
    const result = assessNovelDownload({ book, catalog: mixed, files: mixed.map((item) => chapter(item.order, item.title, longBody)) });
    expect(result.complete).toBe(false);
    expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining(['catalog_duplicate_number', 'catalog_number_regression']));
  });

  it('skips announcement entries instead of rejecting the edition', () => {
    const withNotes: CatalogChapter[] = [
      { order: 1, title: '第1章 海边来信', url: 'http://127.0.0.1:18870/plain/ok/c1.html' },
      { order: 2, title: '请假一天。', url: 'http://127.0.0.1:18870/plain/ok/note1.html' },
      { order: 3, title: '第2章 海边来信', url: 'http://127.0.0.1:18870/plain/ok/c2.html' },
      { order: 4, title: '感谢', url: 'http://127.0.0.1:18870/plain/ok/note2.html' },
      { order: 5, title: '请假一天。', url: 'http://127.0.0.1:18870/plain/ok/note3.html' },
      { order: 6, title: '第3章 海边来信', url: 'http://127.0.0.1:18870/plain/ok/c3.html' },
    ];
    const result = assessNovelDownload({ book, catalog: withNotes, files: withNotes.map((item) => chapter(item.order, item.title, longBody)) });
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.chapters.map((item) => item.order)).toEqual([1, 3, 6]);
    expect(composeValidatedText(book, result.chapters)).not.toContain('请假一天');
    expect(result.warnings.map((item) => item.code)).toContain('catalog_announcement');
  });

  it('does not require announcement pages to exist', () => {
    const withNotes: CatalogChapter[] = [
      { order: 1, title: '第1章 海边来信', url: 'http://127.0.0.1:18870/plain/ok/c1.html' },
      { order: 2, title: '上架感言', url: 'http://127.0.0.1:18870/plain/ok/note.html' },
      { order: 3, title: '第2章 海边来信', url: 'http://127.0.0.1:18870/plain/ok/c2.html' },
    ];
    const result = assessNovelDownload({ book, catalog: withNotes, files: [chapter(1, '第1章 海边来信', longBody), chapter(3, '第2章 海边来信', longBody)] });
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('keeps real front and back matter as chapters', () => {
    const matter: CatalogChapter[] = [
      { order: 1, title: '楔子 繁华过眼', url: 'http://127.0.0.1:18870/plain/ok/p.html' },
      { order: 2, title: '第1章 海边来信', url: 'http://127.0.0.1:18870/plain/ok/c1.html' },
      { order: 3, title: '番外 雪夜', url: 'http://127.0.0.1:18870/plain/ok/e.html' },
      { order: 4, title: '第2章 海边来信', url: 'http://127.0.0.1:18870/plain/ok/c2.html' },
    ];
    const result = assessNovelDownload({ book, catalog: matter, files: matter.map((item) => chapter(item.order, item.title, longBody)) });
    expect(result.complete).toBe(true);
    expect(result.chapters.map((item) => item.title)).toEqual(['楔子 繁华过眼', '第1章 海边来信', '番外 雪夜', '第2章 海边来信']);
  });

  it('still rejects chapters whose numbers jump between adjacent entries', () => {
    const jumped: CatalogChapter[] = [
      { order: 1, title: '第1章 海边来信', url: 'http://127.0.0.1:18870/plain/ok/c1.html' },
      { order: 2, title: '第4章 海边来信', url: 'http://127.0.0.1:18870/plain/ok/c2.html' },
      { order: 3, title: '第5章 海边来信', url: 'http://127.0.0.1:18870/plain/ok/c3.html' },
    ];
    const result = assessNovelDownload({ book, catalog: jumped, files: [], catalogOnly: true });
    expect(result.complete).toBe(false);
    expect(result.issues.map((item) => item.code)).toContain('catalog_number_order_mismatch');
  });

  it('rejects a catalog that changed during the download', () => {
    const after = catalog();
    after[1] = { ...after[1]!, url: 'http://127.0.0.1:18870/plain/ok/c2-new.html' };
    const result = assessNovelDownload({ book, catalog: catalog(), files: files(), catalogAfter: after });
    expect(result.complete).toBe(false);
    expect(result.issues.map((item) => item.code)).toContain('catalog_changed');
  });

  it('rejects placeholder and duplicated bodies', () => {
    const broken = files();
    broken[0] = { ...broken[0]!, text: `${broken[0]!.title}\n\n　　章节内容加载失败，请稍后再试` };
    broken[2] = { ...broken[2]!, text: broken[1]!.text };
    const result = assessNovelDownload({ book, catalog: catalog(4), files: broken });
    expect(result.complete).toBe(false);
    expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining(['placeholder_chapter', 'missing_chapter']));
  });

  it('rejects non-contiguous orders and duplicate URLs', () => {
    const broken = catalog(4);
    broken[1] = { ...broken[1]!, order: 7 };
    broken[2] = { ...broken[2]!, url: broken[0]!.url };
    const result = assessNovelDownload({ book, catalog: broken, files: files(4) });
    expect(result.complete).toBe(false);
    expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining(['catalog_order_gap', 'catalog_duplicate_url']));
  });

  it('downgrades a few numbering typos on a long, otherwise clean catalog to warnings', () => {
    const long: CatalogChapter[] = Array.from({ length: 100 }, (_, index) => {
      const order = index + 1;
      let title = `第${order}章 测试章节${order}`;
      if (order === 50) title = '第49章 别名甲';
      if (order === 51) title = '第48章 别名乙';
      return { order, title, url: `https://www.biquge365.net/chapter/1/${order}.html` };
    });
    const result = assessNovelDownload({ book, catalog: long, files: [], catalogOnly: true });
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.warnings.map((item) => item.code)).toEqual(expect.arrayContaining(['catalog_duplicate_number', 'catalog_number_regression']));
  });

  it('does not treat multi-part chapters as duplicate numbers', () => {
    const multi: CatalogChapter[] = Array.from({ length: 60 }, (_, index) => ({
      order: index + 1, title: `第一章 异界唐三（${index + 1}）`, url: `https://www.biquge365.net/chapter/1/p${index + 1}.html`,
    }));
    const result = assessNovelDownload({ book, catalog: multi, files: [], catalogOnly: true });
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('allows a larger numbering-error budget for very long serials', () => {
    const long: CatalogChapter[] = Array.from({ length: 1200 }, (_, index) => {
      const order = index + 1;
      return { order, title: order % 10 === 0 ? `第${order - 1}章 变体${order}` : `第${order}章 正常${order}`, url: `https://www.biquge365.net/chapter/1/${order}.html` };
    });
    const result = assessNovelDownload({ book, catalog: long, files: [], catalogOnly: true });
    expect(result.complete).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(100);
  });

  it('still blocks a catalog with an excessive number of numbering errors', () => {
    const bad: CatalogChapter[] = Array.from({ length: 100 }, (_, index) => ({
      order: index + 1,
      title: `第${index % 10}章 章节${index}`,
      url: `https://www.biquge365.net/chapter/1/x${index}.html`,
    }));
    const result = assessNovelDownload({ book, catalog: bad, files: [], catalogOnly: true });
    expect(result.complete).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('recognizes author notes and anniversary posts as appendices', () => {
    expect(isAnnouncementTitle('新书大主宰已发。')).toBe(true);
    expect(isAnnouncementTitle('4.14，斗破两周年了。')).toBe(true);
    const list: CatalogChapter[] = [
      ...catalog(2),
      { order: 3, title: '新书大主宰已发。', url: 'https://www.biquge365.net/chapter/1/a3.html' },
      { order: 4, title: '4.14，斗破两周年了。', url: 'https://www.biquge365.net/chapter/1/a4.html' },
    ];
    const downloaded = files(2);
    const result = assessNovelDownload({ book, catalog: list, files: downloaded });
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.warnings.some((warning) => warning.code === 'catalog_announcement')).toBe(true);
    expect(result.chapters).toHaveLength(2);
  });

  it('normalizes a page heading that omits the catalog chapter marker', () => {
    const alias = files();
    alias[0] = { ...alias[0]!, title: '海边来信' };
    const result = assessNovelDownload({ book, catalog: catalog(), files: alias });
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.warnings.some((warning) => warning.code === 'catalog_title_alias')).toBe(true);
  });

  it('composes a canonical TXT only from validated chapters', () => {
    const result = assessNovelDownload({ book, catalog: catalog(), files: files() });
    const text = composeValidatedText(book, result.chapters);
    expect(text).toContain('书名：海边的信');
    expect(text).toContain('# 第1章 海边来信');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('skips placeholder-only copyright/volume shells instead of rejecting the edition', () => {
    const list: CatalogChapter[] = [
      { order: 1, title: '版权信息', url: 'https://example.test/c1' },
      { order: 2, title: '第一卷', url: 'https://example.test/c2' },
      { order: 3, title: '第一章 我与荒石园', url: 'https://example.test/c3' },
      { order: 4, title: '第二章 我的学校', url: 'https://example.test/c4' },
      { order: 5, title: '第二卷', url: 'https://example.test/c5' },
      { order: 6, title: '第三章 童年的回忆', url: 'https://example.test/c6' },
    ];
    const placeholder = '《昆虫记》第一卷正在手打中，请稍等片刻，内容更新后，请重新刷新页面，即可获取最新更新！';
    const downloaded: DownloadChapterFile[] = [
      chapter(1, '版权信息', `书名：昆虫记\n作者：法布尔\n${placeholder}`),
      chapter(2, '第一卷', placeholder),
      chapter(3, '第一章 我与荒石园', longBody),
      chapter(4, '第二章 我的学校', longBody),
      chapter(5, '第二卷', placeholder),
      chapter(6, '第三章 童年的回忆', longBody),
    ];
    const result = assessNovelDownload({ book, catalog: list, files: downloaded });
    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.warnings.filter((warning) => warning.code === 'source_placeholder_shell')).toHaveLength(3);
    expect(result.chapters.map((item) => item.title)).toEqual(['第一章 我与荒石园', '第二章 我的学校', '第三章 童年的回忆']);
  });

  it('still rejects a placeholder page whose title is a numbered content chapter', () => {
    const downloaded = files();
    downloaded[1] = chapter(2, '第2章 海边来信', '本章正在手打中，请稍等片刻。');
    const result = assessNovelDownload({ book, catalog: catalog(), files: downloaded });
    expect(result.complete).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.map((item) => item.code)).not.toContain('source_placeholder_shell');
  });
});
