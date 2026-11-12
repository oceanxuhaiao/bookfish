import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { buildBook, MAX_BOOK_BYTES, SEGMENT_CHARS, digest } from '../src/books.ts';
let dir: string;
let now: number;
let stores: Library[];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bookfish-library-')); now = 1000000; stores = []; });
afterEach(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
function open(dataDir = dir) { const store = new Library({ dataDir, now: () => now }); stores.push(store); store.open(); return store; }
function input(text = '第一章 海风\n\n' + '海'.repeat(1600) + '\n\n第二章 归来\n' + '归'.repeat(1600), title = '测试短篇') {
  return { filename: 'sample.md', title, author: '测试', base64: Buffer.from(text).toString('base64') };
}
function prepare(store: Library, text?: string) { const b = store.import(input(text)).book; store.select(b.key); return b; }
function task(store: Library) { const t = store.readNext(); if (t.complete) throw new Error('expected unread range'); return t; }
function finish(store: Library, t = task(store)) { return store.finish({ taskId: t.taskId, bookKey: t.bookKey, segmentId: t.segmentId, understanding: '本段描述海边与归途。' }); }

describe('book import and stable segmentation', () => {
  it('preserves all canonical Unicode characters and chapter boundaries in bounded contiguous ranges', () => {
    const text = '# 起点\r\n\r\n' + '🐟海'.repeat(1500) + '\r\n\r\n第二章 归来\r\n结束。';
    const book = buildBook('book.md', '书', '', Buffer.from(text));
    expect(book.segments.map(s => s.text).join('')).toBe(book.text);
    expect(book.totalChars).toBe(Array.from(book.text).length);
    expect(book.segments.some(s => s.chapter === '第二章 归来')).toBe(true);
    let end = 0;
    for (const s of book.segments) { expect(s.start).toBe(end); expect(s.end - s.start).toBe(Array.from(s.text).length); expect(s.end - s.start).toBeLessThanOrEqual(SEGMENT_CHARS); end = s.end; }
    expect(book.segments.some(s => /[\uD800-\uDBFF]$/.test(s.text))).toBe(false);
  });
  it('rejects invalid encoding, binary, empty, oversized files and path-shaped filenames', () => {
    for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from('a\0b'), Buffer.from('  \n '), Buffer.alloc(MAX_BOOK_BYTES + 1, 65)]) {
      expect(() => buildBook('x.txt', '书', '', bytes)).toThrow();
    }
    for (const name of ['../a.txt', 'C:\\a.md', 'a.epub']) expect(() => buildBook(name, '书', '', Buffer.from('书'))).toThrow();
  });
  it('recognizes chapter names without spaces and fills segments instead of offering headings alone', () => {
    const book = buildBook('chapter.txt', '章', '', Buffer.from('第一章海风\n' + '海'.repeat(2000)));
    expect(book.segments[0].chapter).toBe('第一章海风');
    expect(Array.from(book.segments[0].text).length).toBe(SEGMENT_CHARS);
  });
  it('deduplicates canonical content without losing progress and isolates a changed revision', () => {
    const store = open(); const b = prepare(store); finish(store);
    expect(store.import(input()).duplicate).toBe(true);
    const changed = store.import(input('全新正文')).book;
    expect(changed.id).toBe(b.id); expect(changed.revision).not.toBe(b.revision);
    expect(changed.confirmedChars).toBe(0);
    expect(store.list().find(x => x.key === b.key)!.confirmedSegments).toBe(1);
  });
  it('rejects malformed base64 and cannot import by arbitrary filesystem path', () => {
    const store = open();
    expect(() => store.import({ ...input(), base64: 'not valid***' })).toThrow();
    expect(() => store.import({ path: 'C:\\Windows\\secret.txt' })).toThrow();
    expect(store.list()).toEqual([]);
  });
});

describe('confirmed reading protocol', () => {
  it('fetching reuses a single lease and advances provided text only; identical confirmation is idempotent', () => {
    const store = open(); prepare(store); const first = task(store);
    expect(task(store).taskId).toBe(first.taskId);
    expect(store.status().current!.confirmedChars).toBe(0);
    expect(store.status().providedChars).toBeGreaterThan(0);
    const result = finish(store, first);
    expect(result.duplicate).toBe(false);
    expect(finish(store, first)).toEqual({ duplicate: true, receipt: result.receipt });
    expect(store.status().current!.confirmedSegments).toBe(1);
    expect(() => store.finish({ ...result.receipt, understanding: '不同的提交' })).toThrow();
  });
  it('rejects invented task ids, revision or segment mismatches', () => {
    const store = open(); const b = prepare(store); const t = task(store);
    const valid = { taskId: t.taskId, bookKey: b.key, segmentId: t.segmentId, understanding: '理解' };
    for (const patch of [{ taskId: 'invented' }, { bookKey: 'other' }, { segmentId: 1 }, { understanding: 'x'.repeat(601) }]) expect(() => store.finish({ ...valid, ...patch })).toThrow();
    expect(store.status().current!.confirmedSegments).toBe(0);
  });
  it('accepts an empty understanding as the legal "nothing to note" result', () => {
    const store = open(); prepare(store); const t = task(store);
    const receipt = store.finish({ taskId: t.taskId, bookKey: t.bookKey, segmentId: t.segmentId, understanding: '' });
    expect(receipt.duplicate).toBe(false);
    expect(receipt.receipt.understanding).toBe('');
    expect(store.timeline().items[0].summary).toBe('');
    expect(store.status().current!.confirmedSegments).toBe(1);
  });
  it('rejects expired tasks and offers the same range under a fresh task', () => {
    const store = open(); prepare(store); const t = task(store);
    now = t.expiresAt;
    expect(() => finish(store, t)).toThrow(/expired/);
    const next = task(store); expect(next.taskId).not.toBe(t.taskId); expect(next.segmentId).toBe(0);
    finish(store, next); expect(store.status().current!.confirmedSegments).toBe(1);
  });
  it('pause and resume invalidate old tasks but preserve committed progress', () => {
    const store = open(); prepare(store); finish(store); const t = task(store);
    store.setPaused(true); expect(() => task(store)).toThrow(/paused/);
    store.setPaused(false); expect(() => finish(store, t)).toThrow();
    expect(task(store).segmentId).toBe(1);
  });
  it('switching books cancels the pending task and switching back resumes confirmed progress', () => {
    const store = open(); const a = prepare(store); finish(store); const old = task(store);
    const b = store.import(input('另一本书', '另一本')).book; store.select(b.key);
    expect(() => finish(store, old)).toThrow(); store.select(a.key);
    expect(task(store).segmentId).toBe(1);
  });
  it('switching to a changed revision rejects the former version task', () => {
    const store = open(); const original = prepare(store); const old = task(store);
    const updated = store.import(input('替换的内容')).book; store.select(updated.key);
    expect(() => finish(store, old)).toThrow();
    expect(store.status().current!.confirmedChars).toBe(0);
    expect(store.list().find(b => b.key === original.key)!.confirmedChars).toBe(0);
  });
  it('rereads confirmed text without advancing and refuses unread text', () => {
    const store = open(); const b = prepare(store);
    expect(() => store.reread(b.key, 0)).toThrow(); finish(store);
    expect(store.reread(b.key, 0).segment.id).toBe(0);
    expect(store.status().current!.confirmedSegments).toBe(1);
    expect(() => store.reread(b.key, 1)).toThrow();
  });
  it('reaches completion only after every contiguous segment has a confirmation', () => {
    const store = open(); prepare(store);
    while (!store.status().current!.complete) finish(store);
    expect(store.status().current!.progress).toBe(1);
    expect(store.status().current!.confirmedChars).toBe(store.status().current!.totalChars);
    expect(store.readNext().complete).toBe(true);
  });
});

describe('persistence, recovery and failure', () => {
  it('restart resumes the last confirmation, cancels pending work and preserves committed retry receipts', () => {
    const store = open(); const b = prepare(store); const committed = task(store); finish(store, committed); const pending = task(store);
    store.close(); const restored = open();
    expect(restored.status().current!.key).toBe(b.key);
    expect(() => finish(restored, pending)).toThrow();
    expect(finish(restored, committed).duplicate).toBe(true);
    expect(task(restored).segmentId).toBe(1);
  });
  it('a stop blocks confirmation until remount and remount invalidates the task', () => {
    const store = open(); prepare(store); const t = task(store); store.close();
    expect(() => finish(store, t)).toThrow(/not mounted/); store.open();
    expect(() => finish(store, t)).toThrow();
  });
  it('rejects a second writer without interfering with the first writer', () => {
    const store = open(); prepare(store);
    const second = new Library({ dataDir: dir }); stores.push(second);
    expect(() => second.open()).toThrow(/already open/);
    finish(store); expect(store.status().current!.confirmedSegments).toBe(1);
  });
  it('failed writes leave both in-memory progress and previous disk state unchanged', () => {
    let fail = false;
    const store = new Library({ dataDir: dir, now: () => now, write: (file, state) => {
      if (fail) throw new Error('disk full'); writeFileSync(file, JSON.stringify(state));
    } }); stores.push(store); store.open(); prepare(store); const t = task(store);
    const before = readFileSync(store.file, 'utf8'); fail = true;
    expect(() => finish(store, t)).toThrow('disk full');
    expect(store.status().current!.confirmedChars).toBe(0);
    expect(readFileSync(store.file, 'utf8')).toBe(before);
    fail = false; finish(store, t); expect(store.status().current!.confirmedSegments).toBe(1);
  });
  it('corrupt persisted state is kept intact and the writer lock is released', () => {
    const store = open(); prepare(store); store.close(); writeFileSync(store.file, '{broken');
    const next = new Library({ dataDir: dir }); stores.push(next);
    expect(() => next.open()).toThrow();
    expect(readFileSync(store.file, 'utf8')).toBe('{broken');
    expect(existsSync(join(store.dir, 'writer.lock'))).toBe(false);
  });
  it('ignores an interrupted temporary write and recovers the last committed file', () => {
    const store = open(); prepare(store); finish(store); const pending = task(store); store.close();
    writeFileSync(`${store.file}.interrupted.tmp`, '{partial');
    const recovered = open();
    expect(recovered.status().current!.confirmedSegments).toBe(1);
    expect(() => finish(recovered, pending)).toThrow();
    expect(task(recovered).segmentId).toBe(1);
  });
  it('rejects a damaged body index even when a backup checksum has been recomputed', () => {
    const store = open(); prepare(store); const backup = JSON.parse(store.export());
    const state = JSON.parse(backup.payload); state.books[0].book.segments[0].text = '替换的文本';
    const payload = JSON.stringify(state);
    const target = open(join(dir, 'index-target'));
    expect(() => target.restore(JSON.stringify({ ...backup, payload, checksum: digest(payload) }))).toThrow(/inconsistent/);
    expect(target.list()).toEqual([]);
  });
  it('exports and restores exact confirmed content into an empty library while cancelling pending tasks', () => {
    const store = open(); const b = prepare(store); finish(store); const pending = task(store); const backup = store.export();
    const recovered = open(join(dir, 'restored'));
    expect(recovered.restore(backup).restoredBooks).toBe(1);
    expect(recovered.status().current!.confirmedSegments).toBe(1);
    expect(recovered.reread(b.key, 0).segment.text).toBe(store.reread(b.key, 0).segment.text);
    expect(() => finish(recovered, pending)).toThrow();
    expect(() => recovered.restore(backup)).toThrow(/empty library/);
  });
  it('rejects checksum damage, inconsistent indexes and forged progress without changing live state', () => {
    const store = open(); prepare(store); const backup = JSON.parse(store.export());
    const target = open(join(dir, 'target'));
    expect(() => target.restore(JSON.stringify({ ...backup, checksum: 'bad' }))).toThrow();
    const content = JSON.parse(backup.payload); content.books[0].frontier = 1;
    const payload = JSON.stringify(content);
    expect(() => target.restore(JSON.stringify({ ...backup, payload, checksum: digest(payload) }))).toThrow(/continuous/);
    expect(target.list()).toEqual([]);
  });
  it('removal and bulk clearing invalidate tasks and cannot remove other books accidentally', () => {
    const store = open(); const a = prepare(store); const t = task(store);
    const b = store.import(input('另一本', '另一书')).book;
    store.remove(a.key); expect(() => finish(store, t)).toThrow();
    expect(store.list().map(x => x.key)).toEqual([b.key]);
    expect(store.status().current).toBe(null);
    store.clear(); expect(store.list()).toEqual([]);
    store.close(); store.open(); expect(store.list()).toEqual([]);
  });
});
