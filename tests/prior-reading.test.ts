/**
 * BF-DSH-GIT-20261119 · 从指定章节开始阅读（声明式起点）。
 *
 * 守护点：
 *  - 声明起点只记录"此前在别处读过"，不产生任何回执，不计入已读；
 *  - frontier 仍是绝对位置，阅读从 skip 开始连续推进；
 *  - 起点必须是章节边界，且只允许在任何阅读发生之前声明；
 *  - 起点之前的正文对检索、回查、日志证据与 SSM 故事记忆都不可见；
 *  - 快照/归档还原后 skip 保持。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';

let dir: string;

const CHAPTER = (n: number, body: string) => `第${n}章 章节${n}\n\n${body}\n\n`;
const TEXT =
  CHAPTER(1, '藏经阁秘密：黎望把灯芯剪短了一点。'.repeat(150)) +
  CHAPTER(2, '沈岸把木箱搬到灯塔下面。'.repeat(150)) +
  CHAPTER(3, '雾散了，风从东边来。'.repeat(150));

function open(options: Record<string, unknown> = {}) {
  const library = new Library({ dataDir: dir, ...options });
  library.open();
  return library;
}

function importAndSelect(library: Library) {
  const key = library.importBytes({ filename: 'sample.txt', title: '分章样本' }, Buffer.from(TEXT)).book.key;
  library.select(key);
  return key;
}

/** readNext returns either a single item or a batch depending on count. */
function taskOf(batch: unknown) {
  const value = batch as { segment?: unknown; segments?: unknown };
  return (Array.isArray(value.segments) ? value.segments[0] : value.segment) as {
    taskId: string; bookKey: string; segmentId: number;
  };
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bookfish-start-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('declared start', () => {
  it('records a chapter start without claiming anything was read', () => {
    const library = open();
    try {
      const key = importAndSelect(library);
      const chapters = library.chapters(key) as { items: Array<{ title: string; segment: number }> };
      expect(chapters.items.length).toBeGreaterThanOrEqual(3);
      const start = chapters.items[1]!.segment;
      const view = library.setReadingStart(key, start) as Record<string, unknown>;
      expect(view.priorReadingSegments).toBe(start);
      expect(view.positionSegments).toBe(start);
      expect(view.confirmedSegments).toBe(0);
      expect(view.confirmedChars).toBe(0);
      expect(view.chapter).toContain('第2章');
      expect((library.journal(key) as Record<string, unknown>).confirmedRanges).toBe(0);
    } finally { library.close(); }
  });

  it('reads forward from the declared start and keeps absolute receipts', () => {
    const library = open();
    try {
      const key = importAndSelect(library);
      const chapters = library.chapters(key) as { items: Array<{ segment: number }> };
      const start = chapters.items[1]!.segment;
      library.setReadingStart(key, start);
      const task = taskOf(library.readNext(1));
      expect(task.segmentId).toBe(start);
      library.finish({ taskId: task.taskId, bookKey: key, segmentId: task.segmentId, understanding: '从这里开始读。' });
      const view = library.status().current as Record<string, unknown>;
      expect(view.confirmedSegments).toBe(1);
      expect(view.positionSegments).toBe(start + 1);
      expect((library.journal(key) as { confirmedRanges: number }).confirmedRanges).toBe(1);
    } finally { library.close(); }
  });

  it('rejects a mid-chapter start, an out-of-range start, and a second declaration after reading', () => {
    const library = open();
    try {
      const key = importAndSelect(library);
      const chapters = library.chapters(key) as { items: Array<{ segment: number }> };
      const second = chapters.items[1]!.segment;
      expect(() => library.setReadingStart(key, second + 1)).toThrow(/first segment of a chapter/);
      expect(() => library.setReadingStart(key, 9999)).toThrow(/out of range/);
      library.setReadingStart(key, second);
      const task = taskOf(library.readNext(1));
      library.finish({ taskId: task.taskId, bookKey: key, segmentId: task.segmentId, understanding: '读了。' });
      expect(() => library.setReadingStart(key, chapters.items[2]!.segment)).toThrow(/locked/);
    } finally { library.close(); }
  });

  it('keeps the declared start across remount and archive restore', () => {
    const first = open();
    let key: string;
    let start: number;
    const archive = join(dir, 'backup.bfbak');
    try {
      key = importAndSelect(first);
      const chapters = first.chapters(key) as { items: Array<{ segment: number }> };
      start = chapters.items[1]!.segment;
      first.setReadingStart(key, start);
      first.writeArchive(archive);
    } finally { first.close(); }

    const remounted = open();
    try {
      expect((remounted.list().find((b) => b.key === key) as Record<string, unknown>).priorReadingSegments).toBe(start);
    } finally { remounted.close(); }

    const restored = new Library({ dataDir: join(dir, 'restored') });
    restored.open();
    try {
      restored.restoreArchive(archive);
      const view = restored.list().find((b) => b.key === key) as Record<string, unknown>;
      expect(view.priorReadingSegments).toBe(start);
      expect(view.positionSegments).toBe(start);
    } finally { restored.close(); }
  });
});

describe('hidden text stays hidden', () => {
  it('never returns pre-start text from search or reread', () => {
    const library = open();
    try {
      const key = importAndSelect(library);
      const chapters = library.chapters(key) as { items: Array<{ segment: number }> };
      const start = chapters.items[1]!.segment;
      library.setReadingStart(key, start);
      const task = taskOf(library.readNext(1));
      library.finish({ taskId: task.taskId, bookKey: key, segmentId: task.segmentId, understanding: '读了。' });
      // Chapter 2 was read here; chapter 1 only "elsewhere".
      expect((library.search({ query: '藏经阁秘密' }) as { items: unknown[] }).items).toHaveLength(0);
      expect((library.search({ query: '灯芯' }) as { items: unknown[] }).items).toHaveLength(0);
      expect((library.search({ query: '灯塔' }) as { items: unknown[] }).items.length).toBeGreaterThan(0);
      expect(() => library.reread(key, 0)).toThrow(/Only confirmed/);
    } finally { library.close(); }
  });

  it('refuses journal evidence that cites text before the start', () => {
    const library = open();
    try {
      const key = importAndSelect(library);
      const chapters = library.chapters(key) as { items: Array<{ segment: number }> };
      const start = chapters.items[1]!.segment;
      library.setReadingStart(key, start);
      const task = taskOf(library.readNext(1));
      library.finish({ taskId: task.taskId, bookKey: key, segmentId: task.segmentId, understanding: '读了。' });
      expect(() => library.reflect({ bookKey: key, requestId: 'r1', episode: {
        trigger: '回想', interpretation: '想起前面', evidence: [{ segmentId: 0, quote: '藏经阁秘密' }],
      } })).toThrow(/Evidence must belong to a confirmed range/);
    } finally { library.close(); }
  });
});
