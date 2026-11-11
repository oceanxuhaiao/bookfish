import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchCatalog, fetchChapter, catalogUrl } from '../src/biquge.ts';
import { SourceError, type HtmlFetcher } from '../src/source-types.ts';
import { Library } from '../src/library.ts';
import { Sources } from '../src/sources.ts';
import { fixture, ROOT, catalogPage, chapterPage } from './fixtures/biquge.ts';
let dir: string; let stores: Library[];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bookfish-source-')); stores = []; });
afterEach(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
function open(sub = '') { const store = new Library({ dataDir: join(dir, sub) }); stores.push(store); store.open(); return store; }
function confirmCached(store: Library) {
  while (store.status().current!.confirmedSegments < store.status().current!.totalSegments) {
    const t = store.readNext(); if (t.complete) break;
    store.finish({ taskId: t.taskId, bookKey: t.bookKey, segmentId: t.segmentId, understanding: '伙伴沿路回家。' });
  }
}
describe('Biquge catalog and paginated chapters', () => {
  it('normalizes directory, index and chapter URLs, without accepting arbitrary domains or routes', () => {
    expect(catalogUrl(ROOT + '1_2/')).toBe(ROOT); expect(catalogUrl(ROOT + 'index_2.html')).toBe(ROOT);
    expect(catalogUrl(ROOT.replace('https:', 'http:'))).toBe(ROOT);
    for (const url of ['https://example.com/sample/', 'https://www.02345.cc/', ROOT + '?q=x', ROOT + '#anchor', 'file:///etc/passwd']) expect(() => catalogUrl(url)).toThrow();
  });
  it('fetches all catalog pages in order and excludes latest-chapter recommendations', async () => {
    const f = fixture(); const catalog = await f.catalog();
    expect(catalog.chapters.map(c => c.url)).toEqual([ROOT + '1/', ROOT + '2/', ROOT + '3/']);
    expect(f.requests).toEqual([ROOT, ROOT + 'index_2.html']);
  });
  it('rejects missing, overlapping or identity-changing catalog pages rather than importing a partial list', async () => {
    for (const replacement of [catalogPage(2, 4), catalogPage(2, 3, '另一本书'), catalogPage(1)]) {
      const f = fixture(); f.pages.set(ROOT + 'index_2.html', replacement);
      await expect(f.catalog()).rejects.toThrow();
    }
  });
  it('joins every page of a chapter, decodes HTML and removes ads, scripts and page markers', async () => {
    const f = fixture(); const catalog = await f.catalog(); const result = await fetchChapter(catalog, 0, f.get);
    expect(result.pages).toHaveLength(2); expect(result.text).toContain('第1章第1页'); expect(result.text).toContain('第1章第2页');
    expect(result.text).not.toContain('广告内容'); expect(result.text).not.toContain('throw Error'); expect(result.text).not.toContain('第(1/2)页');
  });
  it('rejects a missing subpage, next-page jump, chapter mismatch or changed page count', async () => {
    for (const change of ['missing', 'jump', 'title', 'count']) {
      const f = fixture(); const catalog = await f.catalog();
      if (change === 'missing') f.pages.delete(ROOT + '1_2/');
      if (change === 'jump') f.pages.set(ROOT + '1/', chapterPage(0, 1, 2).replace('1_2/', '2/'));
      if (change === 'title') f.pages.set(ROOT + '1_2/', chapterPage(1, 2, 2));
      if (change === 'count') f.pages.set(ROOT + '1_2/', chapterPage(0, 2, 3));
      await expect(fetchChapter(catalog, 0, f.get)).rejects.toThrow();
    }
  });
  it('does not mistake an introduction, login form, paywall or challenge for chapter text', async () => {
    const cases: Array<[string, string]> = [
      ['<title>登录</title><input type=password>', 'needs_login'], ['<body>本章为VIP章节，购买本章</body>', 'restricted'],
      ['<title>Just a moment</title>', 'restricted'], ['<body><h1>简介</h1><p>小说介绍</p></body>', 'invalid_content'],
    ];
    for (const [html, code] of cases) {
      const f = fixture(); const catalog = await f.catalog(); f.pages.set(ROOT + '1/', html);
      await expect(fetchChapter(catalog, 0, f.get)).rejects.toMatchObject({ code });
    }
  });
  it('refuses a hidden continuation when a page falsely claims the chapter is complete', async () => {
    const f = fixture(); const catalog = await f.catalog();
    f.pages.set(ROOT + '1/', chapterPage(0, 1, 2).replaceAll('第(1/2)页', ''));
    await expect(fetchChapter(catalog, 0, f.get)).rejects.toMatchObject({ code: 'missing' });
  });
});
describe('source integration and progress', () => {
  it('imports from a chapter URL but starts at the beginning; a cached prefix never counts as the whole novel', async () => {
    const f = fixture(); const store = open(); const service = new Sources(store, f.get);
    const result = await service.resolve(ROOT + '2/'); store.select(result.book!.key);
    expect(result.book!.source!.cachedChapters).toBe(1); expect(result.book!.source!.totalChapters).toBe(3);
    expect(result.book!.confirmedChars).toBe(0); confirmCached(store);
    expect(store.status().current!.complete).toBe(false); expect(store.status().current!.progress).toBeCloseTo(1 / 3);
    expect(() => store.readNext()).toThrow(/not cached/);
    await service.ensureNext(); confirmCached(store); await service.ensureNext(); confirmCached(store);
    expect(store.status().current!.complete).toBe(true); expect(store.status().current!.progress).toBe(1);
  });
  it('does not store half a chapter or skip it after a fetch fails, then retries at the same position', async () => {
    const f = fixture(); f.pages.delete(ROOT + '1_2/'); const store = open(); const service = new Sources(store, f.get);
    const result = await service.resolve(ROOT); store.select(result.book!.key);
    expect(result.book!.source!.cachedChapters).toBe(0); expect(result.book!.source!.status).toBe('missing');
    expect(store.status().current!.complete).toBe(false); expect(store.status().current!.confirmedChars).toBe(0);
    f.pages.set(ROOT + '1_2/', chapterPage(0, 2, 2)); await service.ensureNext();
    expect(store.status().current!.source!.cachedChapters).toBe(1); expect(store.status().current!.source!.error).toBe(null);
  });
  it('coalesces concurrent next-chapter fetches and never changes previously confirmed segment bytes', async () => {
    const f = fixture(); const store = open(); const service = new Sources(store, f.get);
    const result = await service.resolve(ROOT); store.select(result.book!.key); confirmCached(store);
    const original = store.reread(result.book!.key, 0);
    await Promise.all([service.ensureNext(), service.ensureNext()]);
    expect(f.requests.filter(u => u === ROOT + '2/')).toHaveLength(1);
    expect(store.reread(result.book!.key, 0)).toEqual(original);
  });
  it('preserves remote cache, provenance and progress across restart and backup recovery without network calls', async () => {
    const f = fixture(); const store = open(); const service = new Sources(store, f.get);
    const result = await service.resolve(ROOT); store.select(result.book!.key); confirmCached(store); const backup = store.export(); store.close();
    store.open(); expect(store.status().current!.source!.confirmedChapters).toBe(1);
    const recovered = open('restore'); recovered.restore(backup);
    expect(recovered.status().current!.source!.bookUrl).toBe(ROOT);
    expect(recovered.reread(result.book!.key, 0).segment.text).toContain('伙伴');
    expect(recovered.status().current!.complete).toBe(false);
  });
  it('keeps changed catalog versions and same-title books on separate URLs isolated', async () => {
    const f = fixture(); const store = open(); const service = new Sources(store, f.get);
    const original = await service.resolve(ROOT); store.select(original.book!.key); confirmCached(store);
    f.pages.set(ROOT, catalogPage().replace('第二章 归途', '第二章 新归途'));
    const next = await service.resolve(ROOT);
    expect(next.book!.key).not.toBe(original.book!.key); expect(next.book!.confirmedChars).toBe(0);
    expect(store.list().find(b => b.key === original.book!.key)!.confirmedChars).toBeGreaterThan(0);
    const otherRoot = 'https://www.02345.cc/another/';
    for (const [url, html] of [...f.pages]) f.pages.set(url.replace(ROOT, otherRoot), html.replaceAll(ROOT, otherRoot));
    const other = await service.resolve(otherRoot);
    expect(other.book!.id).not.toBe(original.book!.id); expect(other.book!.confirmedChars).toBe(0);
  });
  it('does not commit a late fetch after pause or selection changes', async () => {
    const f = fixture(); const store = open(); const init = new Sources(store, f.get); const imported = await init.resolve(ROOT);
    store.select(imported.book!.key); confirmCached(store);
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: HtmlFetcher = async (url, signal) => { await gate; return f.get(url, signal); };
    const service = new Sources(store, slow); const fetching = service.ensureNext();
    store.setPaused(true); release!(); await expect(fetching).rejects.toMatchObject({ code: 'cancelled' });
    expect(store.status().current!.source!.cachedChapters).toBe(1);
  });
  it('does not commit cancelled source work or lose local progress when a source is unavailable', async () => {
    const f = fixture(); const store = open(); const service = new Sources(store, f.get);
    const abort = new AbortController(); abort.abort(); await expect(service.resolve(ROOT, abort.signal)).rejects.toThrow(); expect(store.list()).toEqual([]);
    const result = await service.resolve(ROOT); store.select(result.book!.key); confirmCached(store); f.pages.delete(ROOT + '2/');
    await expect(service.ensureNext()).rejects.toMatchObject({ code: 'missing' });
    expect(store.status().current!.source!.confirmedChapters).toBe(1); expect(store.status().current!.complete).toBe(false);
  });
  it('stops new page requests when network access is disabled mid-import', async () => {
    const f = fixture(); const store = open(); let allowed = true;
    const get: HtmlFetcher = async (url, signal) => { const page = await f.get(url, signal); if (url === ROOT) allowed = false; return page; };
    const service = new Sources(store, get, () => allowed);
    await expect(service.resolve(ROOT)).rejects.toMatchObject({ code: 'restricted' });
    expect(f.requests).toEqual([ROOT]); expect(store.list()).toEqual([]);
  });
  it('does not claim an ongoing or unknown-status novel is finished after reading its current snapshot', async () => {
    for (const status of ['连载', '未知']) {
      const f = fixture(); f.pages.set(ROOT, catalogPage().replace('content="完本"', `content="${status}"`));
      f.pages.set(ROOT + 'index_2.html', catalogPage(2).replace('content="完本"', `content="${status}"`));
      const store = open(status); const service = new Sources(store, f.get); const book = await service.resolve(ROOT); store.select(book.book!.key);
      confirmCached(store); await service.ensureNext(); confirmCached(store); await service.ensureNext(); confirmCached(store);
      expect(store.status().current!.progress).toBe(1); expect(store.status().current!.complete).toBe(false);
      expect(() => store.readNext()).toThrow(/does not mark/);
    }
  });
});
