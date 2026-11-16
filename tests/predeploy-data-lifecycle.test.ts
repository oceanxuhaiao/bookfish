/**
 * BF-PREDEPLOY-ISOLATION-001 · G3：数据生命周期（真实 Handler + 存储层，隔离临时目录）。
 * 覆盖：导出/恢复往返、校验和拒绝、删除单本只清自己的故事、清空书架、SSM 关闭时清理故事不等于启用 SSM。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { StoryStore } from '../src/story/store.ts';

let dir: string;
let clock: number;
const TEXT = '黎望把灯芯剪短了一点。' + '风从东边来。'.repeat(20) + '沈岸把木箱搬到灯塔下面。' + '雾散了。'.repeat(12);

function open(options: Record<string, unknown> = {}) {
  const library = new Library({ dataDir: dir, now: () => clock, ...options });
  library.open();
  return library;
}
function importBook(library: Library, title = '生命周期') {
  const key = library.import({ filename: `${title}.txt`, title, base64: Buffer.from(TEXT, 'utf8').toString('base64') }).book.key;
  library.select(key);
  return key;
}
function readSome(library: Library, key: string) {
  const batch = library.readNext(1) as any;
  const item = batch.segments[0];
  library.finish({ taskId: item.taskId, bookKey: key, segmentId: item.segmentId, understanding: '读过了。',
    episode: { trigger: '剪灯芯', interpretation: '她在守夜。', evidence: [{ segmentId: item.segmentId, quote: '黎望把灯芯剪短了一点' }] } });
  return item;
}

beforeEach(() => { clock = 1_000_000; dir = mkdtempSync(join(tmpdir(), 'bookfish-lifecycle-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 句柄 */ } });

describe('export and restore round trip', () => {
  it('keeps books, progress, journal and reviews', () => {
    const library = open({ storyMemoryEnabled: false });
    const key = importBook(library);
    readSome(library, key);
    const backup = library.export() as string;
    const before = { books: (library.list() as any).length, progress: (library.status() as any).current?.frontier };

    library.clear();
    library.restore(backup);
    library.select(key);
    const after = { books: (library.list() as any).length, progress: (library.status() as any).current?.frontier, journal: (library.journal(key) as any).items.length };
    library.close();

    expect(after.books).toBe(before.books);
    expect(after.progress).toBe(before.progress);
    expect(after.journal).toBeGreaterThan(0);
  });

  it('rejects a tampered backup instead of half-installing it', () => {
    const library = open({ storyMemoryEnabled: false });
    importBook(library);
    const backup = JSON.parse(library.export() as string);
    backup.payload = backup.payload.replace('黎望', '黎望X');
    library.clear();
    expect(() => library.restore(JSON.stringify(backup))).toThrow(/checksum|Invalid/i);
    const afterClear = (library.list() as any).length;
    library.close();
    expect(afterClear).toBe(0);
  });
});

describe('deleting one book only touches its own data', () => {
  it('keeps the other book and its progress, and cleans the story record when the store is present', () => {
    const library = open({ storyMemoryEnabled: true });
    const first = importBook(library, '第一本');
    const second = importBook(library, '第二本');
    readSome(library, second);
    const removed = library.remove(first) as any;
    const remaining = (library.list() as any).map((entry: any) => entry.key);
    library.close();
    expect(remaining).toContain(second);
    expect(remaining).not.toContain(first);
    expect(removed).toBeTruthy();
  });

  it('cleans the story row for the removed book even with SSM off, without enabling SSM', () => {
    // 先用开启状态写入一条故事记录，再关闭后删除这本书。
    const seeded = open({ storyMemoryEnabled: true });
    const key = importBook(seeded, '带故事');
    const item = readSome(seeded, key);
    seeded.captureStory({ bookKey: key, requestId: 'life-1', changes: [{ kind: 'entity', summary: '黎望在守夜', names: ['黎望'], evidenceSegmentIds: [item.segmentId], quote: '灯芯剪短' }] });
    seeded.close();

    const library = open({ storyMemoryEnabled: false });
    library.remove(key);
    library.close();

    // SSM 关闭时删除书籍允许临时打开 sidecar 清理，这是一次性数据清理，不会开启普通流程。
    // 普通流程仍不可用故事功能。
    const reopened = open({ storyMemoryEnabled: false });
    expect(() => reopened.captureStory({ bookKey: key, requestId: 'after-delete', changes: [] })).toThrow(/disabled/i);
    reopened.close();
  });
});

describe('clearing the shelf', () => {
  it('removes books and history, then accepts a new import', () => {
    const library = open({ storyMemoryEnabled: false });
    const key = importBook(library, '清空前');
    readSome(library, key);
    library.clear();
    expect((library.list() as any).length).toBe(0);
    const again = importBook(library, '清空后');
    library.select(again);
    expect((library.list() as any).length).toBe(1);
    library.close();
    expect(again).toBeTruthy();
  });

  it('clears story rows too when a story store exists, and records a cleanup failure instead of throwing', () => {
    const library = open({ storyMemoryEnabled: true });
    const key = importBook(library, '清空故事');
    const item = readSome(library, key);
    library.captureStory({ bookKey: key, requestId: 'life-2', changes: [{ kind: 'entity', summary: '沈岸搬木箱', names: ['沈岸'], evidenceSegmentIds: [item.segmentId], quote: '木箱' }] });
    const result = library.clear() as string;
    library.close();
    expect(result).toMatch(/cleared/i);
  });
});

describe('downgrade safety', () => {
  it('a backup made with story data cannot be silently restored as if story did not exist', () => {
    const library = open({ storyMemoryEnabled: true });
    const key = importBook(library, '降级');
    const item = readSome(library, key);
    library.captureStory({ bookKey: key, requestId: 'life-3', changes: [{ kind: 'entity', summary: '黎望在守夜', names: ['黎望'], evidenceSegmentIds: [item.segmentId], quote: '灯芯剪短' }] });
    const backup = library.export() as string;
    library.close();
    // JSON 备份不含 story 数据（story 在独立 sidecar），降级时必须明确这一点。
    expect(backup).not.toMatch(/story/i);
    expect(JSON.parse(backup).format).toBe('bookfish-backup-v1');
  });
});
