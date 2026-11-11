import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Library } from '../src/library.ts';
import { digest } from '../src/books.ts';
import { serialCatalogHash, type SerialRecord } from '../src/serial-types.ts';
import type { CachedChapter, ChapterLink, SourceCatalog } from '../src/source-types.ts';

let dir: string, lib: Library;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bookfish-serial-')); lib = new Library({ dataDir: dir }); lib.open(); });
afterEach(() => { lib.close(); rmSync(dir, { recursive: true, force: true }); });

const bookUrl = 'https://serial.test/book/1/';
function chapter(id: string, title: string, order: number): ChapterLink { return { id, title, url: `${bookUrl}${order}/` }; }
function catalog(chapters: ChapterLink[], status: 'ongoing' | 'finished' | 'unknown' = 'ongoing'): SourceCatalog {
  const value: SourceCatalog = { adapter: 'controlled-serial-v1', bookUrl, title: '受控连载', author: '测试作者', declaredTotal: chapters.length,
    chapters: chapters.map((c) => ({ ...c })), publicationStatus: status, fetchedAt: new Date().toISOString(), hash: '', complete: true, pageCount: 1 };
  value.hash = serialCatalogHash(value); return value;
}
function record(status: 'ongoing' | 'finished' | 'unknown' = 'ongoing'): SerialRecord {
  return { serialId: randomUUID(), editionEpoch: 1, contentVersion: 1, subscriptionRevision: 1,
    sourceId: 'controlled-serial-v1', sourceBookId: 'book/1', bookUrl,
    capabilities: { catalog: true, chapterContent: true, stableChapterId: true, chapterRevision: false, publicationStatus: true, cancellation: true, conditionalRequest: false, rateLimit: 'observed' },
    authorization: 'unknown', authorizationNote: '受控原创源', publicationEvidence: { status, source: 'fixture', observedAt: new Date().toISOString(), note: '' },
    subscription: { enabled: true, intervalMinutes: 60, nextCheckAt: null, lastAttemptAt: null, lastSuccessfulCheckAt: null, failures: 0, backoffUntil: null },
    receipts: [], layout: [], lastCheck: null };
}
function body(index: number, text: string): CachedChapter {
  return { index, text, hash: digest(text), fetchedAt: new Date().toISOString(), pages: [{ url: `${bookUrl}${index + 1}/`, hash: digest('page-' + index) }] };
}
function seed(chapters = 2) {
  const links = Array.from({ length: chapters }, (_, i) => chapter(`c${i + 1}`, `第${i + 1}章`, i + 1));
  const cat = catalog(links);
  const created = lib.createSerial({ catalog: cat, serial: record(), chapters: [body(0, '海风把灯吹灭。'.repeat(1500))] }, lib.generation());
  return { cat, links, book: created.book, serialId: created.book.serial!.serialId, key: created.book.key };
}
describe('serial identity, append and evidence', () => {
  it('keeps the stable key, frontier and old segment bytes when a chapter is appended', () => {
    const s = seed();
    lib.select(s.key);
    const total = lib.status().current!.totalSegments;
    for (let i = 0; i < total; i++) { const t = lib.readNext(); if (t.complete) break; lib.finish({ ...t, understanding: '合成追更验证' }); }
    const segmentsBefore = Array.from({ length: total }, (_, i) => lib.reread(s.key, i).segment);
    const frontier = total;
    expect(lib.status().current!.confirmedSegments).toBe(total);
    const oldText = lib.reread(s.key, 0).segment.text;
    const next = catalog([...s.links, chapter('c3', '第三章', 3)]);
    const current = lib.serialSubscription(s.key)!;
    const result = lib.commitSerialSync({ bookKey: s.key, expectedSubscriptionRevision: current.subscriptionRevision, expectedContentVersion: current.contentVersion,
      baseCatalogHash: s.cat.hash, catalog: next, chapters: [body(1, '新的章节正文。'.repeat(180))],
      publicationEvidence: { status: 'ongoing', source: 'fixture', observedAt: new Date().toISOString(), note: '' }, receipt: { jobId: randomUUID(), status: 'succeeded', error: null } });
    expect(result.book.key).toBe(s.key);
    expect(result.receipt.addedCount).toBe(1);
    expect(result.book.serial!.contentVersion).toBe(2);
    expect(result.book.serial!.discoveredChapters).toBe(3);
    expect(result.book.serial!.cachedChapters).toBe(2);
    expect(result.book.confirmedSegments).toBe(frontier);
    for (const segment of segmentsBefore) expect(lib.reread(s.key, segment.id).segment).toEqual(segment);
    expect(lib.reread(s.key, 0).segment.text).toBe(oldText);
    expect(result.book.readiness).toBe('backlog');
  });
  it('rejects a changed old chapter or non-contiguous body without changing the accepted snapshot', () => {
    const s = seed();
    const before = lib.list().find((b) => b.key === s.key)!;
    const serial = lib.serialSubscription(s.key)!;
    const changed = catalog([chapter('c1', '第一章（改名）', 1), { ...chapter('c2', '第二章', 2) }]);
    expect(() => lib.commitSerialSync({ bookKey: s.key, expectedSubscriptionRevision: serial.subscriptionRevision, expectedContentVersion: serial.contentVersion,
      baseCatalogHash: s.cat.hash, catalog: changed, chapters: [], publicationEvidence: before.serial!.publicationEvidence,
      receipt: { jobId: randomUUID(), status: 'no_change', error: null } })).toThrow(/titles changed/);
    const gap = catalog([...s.links, chapter('c3', '第三章', 3)]);
    expect(() => lib.commitSerialSync({ bookKey: s.key, expectedSubscriptionRevision: serial.subscriptionRevision, expectedContentVersion: serial.contentVersion,
      baseCatalogHash: s.cat.hash, catalog: gap, chapters: [body(2, '跳章正文。'.repeat(160))], publicationEvidence: before.serial!.publicationEvidence,
      receipt: { jobId: randomUUID(), status: 'succeeded', error: null } })).toThrow(/contiguous/);
    expect(lib.serialSubscription(s.key)!.contentVersion).toBe(serial.contentVersion);
    expect(lib.list().find((b) => b.key === s.key)!.serial!.cachedChapters).toBe(before.serial!.cachedChapters);
  });
  it('reopens with the same stable key, accepted segments and chapter layout', () => {
    const s = seed(3);
    lib.select(s.key); const t = lib.readNext(); lib.finish({ ...t, understanding: '合成重启验证' });
    const frontier = lib.status().current!.confirmedSegments, text = lib.reread(s.key, 0).segment.text;
    const serial = lib.serialSubscription(s.key)!;
    const next = catalog([...s.links, chapter('c4', '第四章', 4)]);
    lib.commitSerialSync({ bookKey: s.key, expectedSubscriptionRevision: serial.subscriptionRevision, expectedContentVersion: serial.contentVersion,
      baseCatalogHash: s.cat.hash, catalog: next, chapters: [body(1, '第二段正文。'.repeat(200))],
      publicationEvidence: { status: 'ongoing', source: 'fixture', observedAt: new Date().toISOString(), note: '' }, receipt: { jobId: randomUUID(), status: 'succeeded', error: null } });
    lib.close(); lib.open();
    const current = lib.status().current!;
    expect(current.key).toBe(s.key); expect(current.confirmedSegments).toBe(frontier);
    expect(lib.serialSubscription(s.key)!.layout.length).toBe(2);
    expect(lib.reread(s.key, 0).segment.text).toBe(text);
  });
  it('archives serial metadata and blocks as BOOKFISH4, then restores with subscription paused', () => {
    const s = seed(2);
    lib.select(s.key); const t = lib.readNext(); lib.finish({ ...t, understanding: '合成备份验证' });
    const serialBefore = lib.serialSubscription(s.key)!;
    const file = join(dir, 'serial.bfbak'); lib.writeArchive(file);
    const restored = new Library({ dataDir: join(dir, 'restore') }); restored.open();
    try {
      restored.restoreArchive(file);
      const book = restored.list()[0];
      expect(book.key).toBe(s.key);
      expect(book.serial!.contentVersion).toBe(serialBefore.contentVersion);
      expect(book.serial!.subscription.enabled).toBe(false);
      expect(book.serial!.subscriptionRevision).toBe(serialBefore.subscriptionRevision + 1);
      expect(restored.reread(s.key, 0).segment.text).toContain('海风');
    } finally { restored.close(); }
  });
  it('updates subscription control without rewriting the cached book blob', () => {
    const s = seed(2);
    const booksDir = join(lib.dir, 'books');
    const before = readdirSync(booksDir);
    const mtime = statSync(join(booksDir, before[0])).mtimeMs;
    lib.setSerialSubscription(s.key, false, 60);
    expect(readdirSync(booksDir)).toEqual(before);
    expect(statSync(join(booksDir, before[0])).mtimeMs).toBe(mtime);
    expect(lib.serialSubscription(s.key)!.subscription.enabled).toBe(false);
    lib.close(); lib.open();
    expect(lib.serialSubscription(s.key)!.subscription.enabled).toBe(false);
  });
  it('keeps an in-flight reading task confirmable while a later chapter is appended', () => {
    const s = seed(2); lib.select(s.key);
    const task = lib.readNext(); if (task.complete) throw new Error('expected a task');
    const next = catalog([...s.links, chapter('c3', '第三章', 3)]);
    const current = lib.serialSubscription(s.key)!;
    const result = lib.commitSerialSync({ bookKey: s.key, expectedSubscriptionRevision: current.subscriptionRevision, expectedContentVersion: current.contentVersion,
      baseCatalogHash: s.cat.hash, catalog: next, chapters: [body(1, '新章正文。'.repeat(1500))],
      publicationEvidence: { status: 'ongoing', source: 'fixture', observedAt: new Date().toISOString(), note: '' }, receipt: { jobId: randomUUID(), status: 'succeeded', error: null } });
    expect(result.book.serial!.cachedChapters).toBe(2);
    const finished = lib.finish({ taskId: task.taskId, bookKey: s.key, segmentId: task.segmentId, understanding: '旧任务在追加后仍可确认' });
    expect(finished.receipt.frontier).toBe(task.segmentId + 1);
    expect(lib.reread(s.key, task.segmentId).segment.text).toBe(task.segment.text);
  });
  it('does not treat an ongoing or unknown serial tail as a finished book', () => {
    const s = seed(1);
    lib.select(s.key);
    const total = lib.status().current!.totalSegments;
    for (let i = 0; i < total; i++) { const t = lib.readNext(); if (t.complete) break; lib.finish({ ...t, understanding: '合成追平验证' }); }
    expect(lib.status().current!.readiness).toBe('caught_up');
    expect(lib.status().current!.complete).toBe(false);
    expect(() => lib.readNext()).toThrow(/等待/);
    expect(() => lib.beginReview({ bookKey: s.key, requestId: 'serial-review' })).toThrow(/finished/);
  });
});
