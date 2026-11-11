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

  it('keeps repeated chapter titles when the repeats belong to separate volumes', () => {
    const entries = [
      '第一章 血尸', '第二章 五十年后',
      '第一章 血尸', '第二章 五十年后',
      '第一章 血尸', '第二章 五十年后',
    ].map((title, index) => ({ order: index + 1, title, url: `https://example.test/repeated/${index + 1}.html` }));
    const result = assess('repeated', entries);
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.warnings.some((item) => item.code === 'catalog_volume_restart')).toBe(true);
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
