import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assessNovelDownload } from '../src/novel-integrity.ts';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/daomu-catalogs.json', import.meta.url), 'utf8')) as Record<string, string[]>;

function catalog(name: keyof typeof fixtures) {
  return fixtures[name].map((title, index) => ({
    order: index + 1,
    title,
    url: `https://example.test/${String(name)}/${index + 1}.html`,
  }));
}

function assess(name: string, entries: Array<{ order: number; title: string; url: string }>) {
  return assessNovelDownload({
    book: { title: '盗墓笔记', author: '南派三叔', sourceId: 1, sourceName: name, bookUrl: 'https://example.test/book' },
    catalog: entries,
    files: [],
    catalogOnly: true,
  });
}

describe('multi-volume catalogs', () => {
  it('accepts the real 盗墓笔记 catalogs from all three failing sources', () => {
    for (const name of ['biquge365', 'ujxsw', 'yeudusk'] as const) {
      const result = assess(name, catalog(name));
      expect(result.complete, `${name}: ${result.issues.map((item) => item.message).join('; ')}`).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.warnings.some((item) => item.code === 'catalog_volume_restart')).toBe(true);
    }
  });

  it('rejects identical chapter titles repeated across unlabelled volumes', () => {
    // Three copies of the same two chapters: the signature of a concatenated
    // duplicate edition, not a multi-volume book.
    const entries = [
      '第一章 血尸', '第二章 五十年后',
      '第一章 血尸', '第二章 五十年后',
      '第一章 血尸', '第二章 五十年后',
    ].map((title, index) => ({ order: index + 1, title, url: `https://example.test/repeated/${index + 1}.html` }));
    const result = assess('repeated', entries);
    expect(result.complete).toBe(false);
    expect(result.issues.some((item) => item.code === 'catalog_duplicate_title')).toBe(true);
  });

  it('keeps repeated chapter titles when explicit volume prefixes differ', () => {
    const entries = [
      '七星鲁王 第一章 血尸', '七星鲁王 第二章 五十年后',
      '怒海潜沙 第一章 血尸', '怒海潜沙 第二章 五十年后',
    ].map((title, index) => ({ order: index + 1, title, url: `https://example.test/prefixed/${index + 1}.html` }));
    const result = assess('prefixed', entries);
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('recognises a renumbered catalog whose chapters are split into parts', () => {
    // Every volume restarts at 第一章 and every chapter is split into
    // （一）（二）（三）; the reset lookahead must collapse the repeated numbers.
    const entries: Array<{ order: number; title: string; url: string }> = [];
    let order = 0;
    for (let volume = 0; volume < 3; volume += 1) {
      for (let number = 1; number <= 6; number += 1) {
        for (const part of ['一', '二', '三']) {
          order += 1;
          entries.push({ order, title: `第${number}章 第${volume + 1}卷故事${number}（${part}）`, url: `https://example.test/parts/${order}.html` });
        }
      }
    }
    const result = assess('parts', entries);
    expect(result.complete, result.issues.map((item) => item.message).join('; ')).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.warnings.some((item) => item.code === 'catalog_volume_restart')).toBe(true);
  });

  it('accepts an unlabelled arc restart whose run starts at 2 because 第一章 is hidden', () => {    const arc = (offset: number, first: number) => Array.from({ length: 8 }, (_, index) => `第${first + index}章 第${offset + index}节 故事`);
    const entries = [
      ...arc(100, 1),
      ...arc(200, 2),
      ...arc(300, 2),
    ].map((title, index) => ({ order: index + 1, title, url: `https://example.test/arc/${index + 1}.html` }));
    const result = assess('arc', entries);
    expect(result.complete, result.issues.map((item) => item.message).join('; ')).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.warnings.some((item) => item.code === 'catalog_volume_restart')).toBe(true);
  });

  it('does not mistake a one-off numbering drop for an arc restart', () => {
    const titles = [
      ...Array.from({ length: 20 }, (_, index) => `第${index + 1}章 连续章节${index + 1}`),
      '第2章 排版错误',
      ...Array.from({ length: 20 }, (_, index) => `第${index + 21}章 后续章节${index + 21}`),
    ];
    const entries = titles.map((title, index) => ({ order: index + 1, title, url: `https://example.test/typo/${index + 1}.html` }));
    const result = assess('typo', entries);
    expect(result.complete).toBe(false);
    expect(result.issues.some((item) => item.code === 'catalog_number_regression' || item.code === 'catalog_duplicate_number')).toBe(true);
  });

  it('accepts an explicit volume reset without requiring a title prefix on every chapter', () => {
    const entries = [
      '七星鲁王 第一章 血尸', '第二章 五十年后',
      '怒海潜沙 第一章 蛇眉铜鱼', '第二章 双层墓墙',
    ].map((title, index) => ({ order: index + 1, title, url: `https://example.test/explicit/${index + 1}.html` }));
    const result = assess('explicit', entries);
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('still rejects one unlabelled numbering reset without enough volume evidence', () => {
    const entries = [
      '第一章 血尸', '第二章 五十年后',
      '第一章 血尸', '第二章 五十年后',
    ].map((title, index) => ({ order: index + 1, title, url: `https://example.test/one-reset/${index + 1}.html` }));
    const result = assess('one-reset', entries);
    expect(result.complete).toBe(false);
    expect(result.issues.some((item) => item.code === 'catalog_number_regression')).toBe(true);
  });

  it('still rejects duplicate titles and numbers inside one volume', () => {
    const entries = [
      '第一章 血尸', '第二章 旧事', '第二章 旧事',
    ].map((title, index) => ({ order: index + 1, title, url: `https://example.test/same-volume/${index + 1}.html` }));
    const result = assess('same-volume', entries);
    expect(result.complete).toBe(false);
    expect(result.issues.some((item) => item.code === 'catalog_duplicate_title')).toBe(true);
    expect(result.issues.some((item) => item.code === 'catalog_duplicate_number')).toBe(true);
  });
});
