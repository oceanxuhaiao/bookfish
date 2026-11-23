import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library, type LibraryOptions } from '../src/library.ts';

let dir: string, now: number, stores: Library[];
function open(options: Partial<LibraryOptions> = {}) {
  const lib = new Library({ dataDir: dir, now: () => now, ...options }); stores.push(lib); lib.open(); return lib;
}
// The quoted sentences appear exactly once so evidence validation can resolve them without an offset.
const TEXT = '序章：海风轻轻吹过岸边，她把信放进抽屉。' + '远处传来潮声。'.repeat(400);
/** One confirmed reading record plus `count-1` appended reflections, all citing the first segment. */
function seed(lib: Library, title: string, count: number) {
  // requestId only accepts ASCII idempotency tokens; the title stays the user-facing name.
  const slug = [...title].map((character) => character.codePointAt(0)!.toString(16)).join('-');
  const book = lib.import({ filename: `${title}.txt`, title, base64: Buffer.from(TEXT).toString('base64') }).book;
  lib.select(book.key);
  const task = lib.readNext(); if (task.complete) throw new Error('expected a segment');
  lib.finish({ taskId: task.taskId, bookKey: task.bookKey, segmentId: task.segmentId, understanding: '她读着海边的段落。',
    episode: { trigger: '海风吹过', interpretation: `${title} 第一次感想`, evidence: [{ segmentId: task.segmentId, quote: '海风轻轻吹过岸边' }] } });
  for (let index = 1; index < count; index++) {
    lib.reflect({ bookKey: book.key, requestId: `${slug}-${index}`,
      episode: { trigger: '抽屉里的信', interpretation: `${title} 第 ${index} 次回想`, mood: index % 3 === 0 ? { label: '有点酸', intensity: 2 } : null,
        evidence: [{ segmentId: task.segmentId, quote: '她把信放进抽屉' }] } });
  }
  return book;
}
function sequences(page: { items: Array<{ sequence: number }> }) { return page.items.map((item) => item.sequence); }
function traverse(lib: Library, order: 'desc' | 'asc', limit: 5 | 10 | 20 | 50) {
  const seen: number[] = [];
  let cursor: { edge: 'before' | 'after'; sequence: number } | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = lib.journalBrowse({ order, limit, ...(cursor ? { cursor } : {}) });
    seen.push(...sequences(page));
    expect(page.hasNext).toBe(page.position.end < page.total);
    if (!page.hasNext) break;
    expect(page.nextCursor).not.toBeNull();
    cursor = page.nextCursor!;
  }
  return seen;
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bookfish-footprint-')); now = Date.parse('2026-11-23T04:00:00Z'); stores = []; });
afterEach(() => { for (const lib of stores) lib.close(); rmSync(dir, { recursive: true, force: true }); });

describe('cross-book footprint browsing', () => {
  it('lists only books that have footprints, with real counts and recency order', () => {
    const lib = open();
    const first = seed(lib, '甲书', 10);
    const second = seed(lib, '乙书', 4);
    seed(lib, '丙书', 6);
    lib.import({ filename: 'empty.txt', title: '空书', base64: Buffer.from(TEXT).toString('base64') });
    const listing = lib.journalBooks();
    expect(listing.total).toBe(20);
    expect(listing.books.map((book) => [book.title, book.count])).toEqual([['丙书', 6], ['乙书', 4], ['甲书', 10]]);
    expect(listing.books.some((book) => book.title === '空书')).toBe(false);
    expect(listing.books.find((book) => book.title === '甲书')!.bookKey).toBe(first.key);
    expect(listing.books.find((book) => book.title === '乙书')!.lastSequence).toBe(lib.journal(second.key).items[0]!.sequence);
  });

  it('pages the newest-first list with a stable exclusive cursor and real position counts', () => {
    const lib = open();
    seed(lib, '甲书', 7);
    seed(lib, '乙书', 8);
    const firstPage = lib.journalBrowse({ limit: 5 });
    expect(firstPage.total).toBe(15);
    expect(firstPage.position).toEqual({ start: 1, end: 5 });
    expect(firstPage.page.count).toBe(5);
    expect(firstPage.hasPrev).toBe(false);
    expect(firstPage.hasNext).toBe(true);
    expect(firstPage.headSequence).toBe(15);
    expect(sequences(firstPage)).toEqual([15, 14, 13, 12, 11]);
    expect(firstPage.nextCursor).toEqual({ edge: 'before', sequence: 11 });
    const secondPage = lib.journalBrowse({ limit: 5, cursor: firstPage.nextCursor! });
    expect(sequences(secondPage)).toEqual([10, 9, 8, 7, 6]);
    expect(secondPage.position).toEqual({ start: 6, end: 10 });
    expect(secondPage.hasPrev).toBe(true);
    expect(secondPage.prevCursor).toEqual({ edge: 'after', sequence: 10 });
    const thirdPage = lib.journalBrowse({ limit: 5, cursor: secondPage.nextCursor! });
    expect(sequences(thirdPage)).toEqual([5, 4, 3, 2, 1]);
    expect(thirdPage.hasNext).toBe(false);
    expect(thirdPage.position).toEqual({ start: 11, end: 15 });
  });

  it('walks every record once in both orders and returns exactly the previous page on 上一页', () => {
    const lib = open();
    seed(lib, '甲书', 9);
    seed(lib, '乙书', 8);
    seed(lib, '丙书', 7);
    const expected = Array.from({ length: 24 }, (_, index) => 24 - index);
    for (const order of ['desc', 'asc'] as const) {
      const seen = traverse(lib, order, 5);
      expect(seen).toHaveLength(24);
      expect(new Set(seen).size).toBe(24);
      expect([...seen].sort((a, b) => b - a)).toEqual(expected);
      const sorted = [...seen].every((value, index) => index === 0 || (order === 'desc' ? seen[index - 1]! > value : seen[index - 1]! < value));
      expect(sorted).toBe(true);
    }
    const firstPage = lib.journalBrowse({ order: 'asc', limit: 5 });
    const secondPage = lib.journalBrowse({ order: 'asc', limit: 5, cursor: firstPage.nextCursor! });
    const back = lib.journalBrowse({ order: 'asc', limit: 5, cursor: secondPage.prevCursor! });
    expect(sequences(back)).toEqual(sequences(firstPage));
    const descFirst = lib.journalBrowse({ limit: 5 });
    const descSecond = lib.journalBrowse({ limit: 5, cursor: descFirst.nextCursor! });
    expect(sequences(lib.journalBrowse({ limit: 5, cursor: descSecond.prevCursor! }))).toEqual(sequences(descFirst));
  });

  it('restores the page that contains a record anchor, aligned to the page grid', () => {
    const lib = open();
    seed(lib, '甲书', 12);
    // desc: anchor 8 has rank 5, so it is the last record of page one.
    const desc = lib.journalBrowse({ anchorSequence: 8, limit: 5 });
    expect(sequences(desc)).toEqual([12, 11, 10, 9, 8]);
    expect(desc.position.start).toBe(1);
    // asc: anchor 8 has rank 8, so its page starts at 6.
    const asc = lib.journalBrowse({ order: 'asc', anchorSequence: 8, limit: 5 });
    expect(sequences(asc)).toEqual([6, 7, 8, 9, 10]);
    expect(asc.position.start).toBe(6);
    // A missing anchor still resolves to the page where it would have been.
    const missing = lib.journalBrowse({ anchorSequence: 5, limit: 5 });
    expect(sequences(missing)).toEqual([7, 6, 5, 4, 3]);
    // Back-to-latest in ascending order is the true last page, not a one-record tail.
    const latest = lib.journalBrowse({ order: 'asc', anchorSequence: 12, limit: 5 });
    expect(sequences(latest)).toEqual([11, 12]);
    expect(latest.position).toEqual({ start: 11, end: 12 });
    expect(latest.hasNext).toBe(false);
  });

  it('keeps already-fetched pages stable while new records are appended', () => {
    const lib = open();
    const book = seed(lib, '甲书', 10);
    const pageOne = lib.journalBrowse({ limit: 5 });
    const pageTwo = lib.journalBrowse({ limit: 5, cursor: pageOne.nextCursor! });
    const before = sequences(pageTwo);
    lib.reflect({ bookKey: book.key, requestId: 'appended', episode: { trigger: '新的潮声', interpretation: '又想起一件事', evidence: [{ segmentId: 0, quote: '海风轻轻吹过岸边' }] } });
    expect(sequences(lib.journalBrowse({ limit: 5, cursor: pageTwo.prevCursor! }))).toEqual(sequences(pageOne));
    expect(sequences(lib.journalBrowse({ limit: 5, cursor: pageOne.nextCursor! }))).toEqual(before);
    expect(lib.journalBrowse({ limit: 5 }).total).toBe(11);
  });

  it('handles sequence gaps after a book deletion without inventing counts', () => {
    const lib = open();
    seed(lib, '甲书', 4);
    const middle = seed(lib, '乙书', 5);
    seed(lib, '丙书', 3);
    lib.remove(middle.key);
    const page = lib.journalBrowse({ limit: 10 });
    expect(page.total).toBe(7);
    const seen = sequences(page);
    expect(seen).toEqual([12, 11, 10, 4, 3, 2, 1]);
    expect(new Set(seen).size).toBe(7);
    expect(page.headSequence).toBe(12);
    expect(page.tailSequence).toBe(1);
    // Sequence gaps make "第 N 条 = sequence N" wrong; the reported position must come from COUNT.
    const tailPage = lib.journalBrowse({ limit: 5, anchorSequence: 1 });
    expect(tailPage.position).toEqual({ start: 6, end: 7 });
    // A deleted record's sequence (9) resolves to the page where it would have been (10 then 4).
    expect(sequences(lib.journalBrowse({ limit: 5, anchorSequence: 9 }))).toEqual([12, 11, 10, 4, 3]);
    expect(lib.journalBrowse({ limit: 5, cursor: { edge: 'before', sequence: 1 } }).position).toEqual({ start: 0, end: 0 });
    expect(lib.journalBrowse({ limit: 5, cursor: { edge: 'before', sequence: 1 } }).hasNext).toBe(false);
  });

  it('supports every offered page size and rejects anything outside the contract', () => {
    const lib = open();
    seed(lib, '甲书', 60);
    for (const limit of [5, 10, 20, 50] as const) {
      const page = lib.journalBrowse({ limit });
      expect(page.items).toHaveLength(limit);
      expect(page.page.count).toBe(limit);
    }
    expect(() => lib.journalBrowse({ limit: 51 })).toThrow(/limit/);
    expect(() => lib.journalBrowse({ limit: 0 })).toThrow(/limit/);
    expect(() => lib.journalBrowse({ order: 'newest' })).toThrow(/order/);
    expect(() => lib.journalBrowse({ cursor: { edge: 'around', sequence: 3 } })).toThrow(/edge/);
    expect(() => lib.journalBrowse({ cursor: { edge: 'before', sequence: 0 } })).toThrow(/sequence/);
    expect(() => lib.journalBrowse({ cursor: { edge: 'before', sequence: 3 }, anchorSequence: 3 })).toThrow(/mutually exclusive/);
    expect(() => lib.journalBrowse({ scope: { bookKey: 'missing' } })).toThrow(/not in the library/);
    expect(() => lib.journalBrowse({ scope: 'everywhere' })).toThrow(/scope/);
  });

  it('scopes counts, paging and anchors to one exact book revision', () => {
    const lib = open();
    const first = seed(lib, '甲书', 6);
    const second = seed(lib, '乙书', 7);
    const scoped = lib.journalBrowse({ scope: { bookKey: second.key }, limit: 5 });
    expect(scoped.total).toBe(7);
    expect(scoped.items.every((item) => item.bookKey === second.key)).toBe(true);
    expect(scoped.items.every((item) => item.bookTitle === '乙书')).toBe(true);
    const onlyFirst = lib.journalBrowse({ scope: { bookKey: first.key }, limit: 10 });
    expect(onlyFirst.items.map((item) => item.sequence)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(lib.journalProbe({ scope: { bookKey: first.key } }).headSequence).toBe(6);
  });

  it('probes new footprints without assuming a baseline and counts only newer records', () => {
    const lib = open();
    seed(lib, '甲书', 3);
    const empty = lib.journalProbe({});
    expect(empty).toEqual({ total: 3, headSequence: 3, tailSequence: 1, count: 0 });
    seed(lib, '乙书', 2);
    expect(lib.journalProbe({}).count).toBe(0);
    expect(lib.journalProbe({ since: 3 })).toMatchObject({ total: 5, count: 2, headSequence: 5 });
    expect(lib.journalProbe({ since: 5 })).toMatchObject({ count: 0 });
    expect(lib.journalProbe({ since: 3 }).count).toBe(2);
  });

  it('freezes a preview batch boundary and reports truncation honestly', () => {
    const lib = open();
    const book = seed(lib, '甲书', 60);
    const batch = lib.journalNew({ since: 0, order: 'desc', limit: 50 });
    expect(batch.maxSequence).toBe(60);
    expect(batch.count).toBe(60);
    expect(batch.items).toHaveLength(50);
    expect(batch.truncated).toBe(true);
    expect(batch.items[0]!.sequence).toBe(60);
    lib.reflect({ bookKey: book.key, requestId: 'during-preview', episode: { trigger: '预览期间', interpretation: '又写了一条', evidence: [{ segmentId: 0, quote: '海风轻轻吹过岸边' }] } });
    const nextBatch = lib.journalNew({ since: batch.maxSequence, order: 'desc', limit: 50 });
    expect(nextBatch.count).toBe(1);
    expect(nextBatch.maxSequence).toBe(61);
    expect(nextBatch.items.map((item) => item.sequence)).toEqual([61]);
    expect(lib.journalProbe({ since: batch.maxSequence }).count).toBe(1);
    const asc = lib.journalNew({ since: 0, order: 'asc', limit: 50 });
    expect(asc.items[0]!.sequence).toBe(1);
  });

  it('filters footprints by keywords across books, scope, fields and pages', () => {
    const lib = open();
    const first = seed(lib, '甲书', 2); const second = seed(lib, '乙书', 2);
    lib.reflect({ bookKey: first.key, requestId: 'kw-a', episode: {
      trigger: '灯塔亮了', interpretation: '她想起海边的灯塔', reason: '灯塔象征回家',
      mood: { label: '微光', intensity: 2 }, characters: [{ name: '阿灯', aliases: ['灯姐'] }],
      questions: ['灯塔还会亮吗'], evidence: [{ segmentId: 0, quote: '海风轻轻吹过岸边' }] } });
    lib.reflect({ bookKey: second.key, requestId: 'kw-b', episode: {
      trigger: '船靠岸', interpretation: 'Lighthouse keeper 驶过灯塔', characters: [{ name: '阿船' }],
      evidence: [{ segmentId: 0, quote: '她把信放进抽屉' }] } });
    const all = lib.journalBrowse({ query: '灯塔', limit: 5 });
    expect(all.total).toBe(2);
    expect(all.query).toEqual(['灯塔']);
    expect(all.items[0]!.trigger).toBe('船靠岸');
    expect(lib.journalBrowse({ query: '阿灯' }).total).toBe(1);
    expect(lib.journalBrowse({ query: '灯姐' }).total).toBe(1);
    expect(lib.journalBrowse({ query: '微光' }).total).toBe(1);
    expect(lib.journalBrowse({ query: '回家' }).total).toBe(1);
    expect(lib.journalBrowse({ query: '亮吗' }).total).toBe(1);
    expect(lib.journalBrowse({ query: 'LIGHTHOUSE' }).total).toBe(1);
    expect(lib.journalBrowse({ query: '灯塔 船' }).total).toBe(1);
    expect(lib.journalBrowse({ scope: { bookKey: first.key }, query: '灯塔' }).total).toBe(1);
    expect(lib.journalBrowse({ query: '不存在' })).toMatchObject({ total: 0, items: [] });
    const pageOne = lib.journalBrowse({ query: '灯塔', limit: 5, order: 'desc' });
    expect(pageOne.position).toEqual({ start: 1, end: 2 });
    const smaller = lib.journalBrowse({ query: '灯塔', limit: 5, order: 'asc' });
    expect(smaller.items.map((item) => item.trigger)).toEqual(['灯塔亮了', '船靠岸']);
    const one = lib.journalBrowse({ query: '灯塔', limit: 5 });
    const target = one.items[0]!.sequence;
    const anchored = lib.journalBrowse({ query: '灯塔', anchorSequence: target, limit: 5 });
    expect(anchored.items[0]!.sequence).toBe(target);
    expect(anchored.total).toBe(2);
    expect(() => lib.journalBrowse({ query: 'a b c d e f g h i' })).toThrow(/eight/);
    expect(() => lib.journalBrowse({ query: 'x'.repeat(41) })).toThrow(/40/);
  });
});
