/**
 * G02 / 阶段 2：整本评论的完整闭环与收尾信号。
 * 只用确定性代码驱动，验证 begin → materials(两种) → finish → 不可变版本。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';

let dir: string;
let library: Library;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-review-closure-'));
  library = new Library({ dataDir: dir, now: () => 1_000_000 });
  library.open();
});
afterEach(() => {
  library.close();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 句柄 */ }
});

/** 重复句 + 唯一句混排：既能测多页 ranges，又能测"引用有歧义时给出真实偏移"。 */
function text(): string {
  const repeated = '潮水打在礁石上。';
  return ['# 第一章', repeated.repeat(6), '沈岸把最后一箱书搬上渔船。', '# 第二章', repeated.repeat(6), '黎望说她记得七年前有人来过。',
    '# 第三章', repeated.repeat(6), '箱子没锁，里面是一叠手写的航海笔记。', '# 第四章', repeated.repeat(6), '远处传来一声汽笛。'].join('\n');
}

function confirmAll(book: { key: string }) {
  library.select(book.key);
  for (let guard = 0; guard < 20; guard++) {
    const batch = library.readNext(2);
    if (batch.complete) return;
    for (const item of batch.segments) {
      library.finish({ taskId: item.taskId, bookKey: book.key, segmentId: item.segmentId, understanding: '' });
    }
  }
  throw new Error('没有读完');
}

/** 取第 0 段里一段真实存在且在本段唯一的引用（逐字，含标点）。 */
function realQuote(book: { key: string }): string {
  const segment = (library.reread(book.key, 0) as { segment: { text: string } }).segment;
  for (const line of segment.text.split('\n').map((value) => value.trim())) {
    if (line.length < 12) continue;
    const quote = Array.from(line).slice(0, 12).join('');
    if (segment.text.split(quote).length === 2) return quote;
  }
  return Array.from(segment.text).slice(0, 12).join('');
}
describe('full-book review closes', () => {
  it('signals when both material collections are complete, and only then', () => {
    const book = library.import({ filename: 'a.txt', title: '闭环样本', base64: Buffer.from(text(), 'utf8').toString('base64') }).book;
    confirmAll(book);
    const begun = library.beginReview({ bookKey: book.key, requestId: 'closure-1' });
    const jobId = begun.job.id;

    // 第一页 ranges 只覆盖一部分：不能说材料齐了。
    const page1 = library.reviewMaterials({ jobId, kind: 'ranges', offset: 0, limit: 2 });
    expect(page1.nextOffset).not.toBeNull();
    expect(page1.materialsComplete).toBe(false);
    expect((page1 as any).pendingMaterials).toContain('ranges');
    expect(String(page1.nextStep)).toMatch(/Still to fetch/);
    expect(String(page1.nextStep)).not.toMatch(/action="finish"/);

    // 翻到最后一页：ranges 齐了，episodes 本来就是 0，此时才允许提示 finish。
    let cursor = page1.nextOffset as number;
    let page: any = page1;
    while (cursor !== null) { page = library.reviewMaterials({ jobId, kind: 'ranges', offset: cursor, limit: 2 }); cursor = page.nextOffset; }
    expect(page.materialsComplete).toBe(true);
    expect(String(page.nextStep)).toMatch(/bookfish_review\(action="finish"\)/);

    // episodes 空集合也要明确报告完整。
    const episodes = library.reviewMaterials({ jobId, kind: 'episodes', offset: 0, limit: 5 });
    expect(episodes.items).toHaveLength(0);
    expect(episodes.materialsComplete).toBe(true);

    const quote = realQuote(book);
    const saved = library.finishReview({ jobId, title: '一只箱子的潮汐', text: '凌晨四点的那一段我读得很慢。'.repeat(8), episodeIds: [], evidence: [{ segmentId: 0, quote }] });
    expect(saved.duplicate).toBe(false);
    expect(saved.review.version).toBe(1);
    expect(saved.review.text.length).toBeGreaterThan(100);

    // 完全相同的重试返回同一版本，不新增。
    const again = library.finishReview({ jobId, title: '一只箱子的潮汐', text: '凌晨四点的那一段我读得很慢。'.repeat(8), episodeIds: [], evidence: [{ segmentId: 0, quote }] });
    expect(again.duplicate).toBe(true);
    expect(library.reviews(book.key).versions.length).toBe(1);
  });

  it('refuses to save before every range page has been fetched', () => {
    const book = library.import({ filename: 'b.txt', title: '未翻完', base64: Buffer.from(text(), 'utf8').toString('base64') }).book;
    confirmAll(book);
    const jobId = library.beginReview({ bookKey: book.key, requestId: 'closure-2' }).job.id;
    const partial = library.reviewMaterials({ jobId, kind: 'ranges', offset: 0, limit: 1 });
    expect(partial.nextOffset).not.toBeNull();
    expect(partial.materialsComplete).toBe(false);
    expect(() => library.finishReview({ jobId, title: 't', text: 'x'.repeat(120), episodeIds: [], evidence: [{ segmentId: 0, quote: realQuote(book) }] }))
      .toThrow(/Request all ranges and episode material pages/);
  });
});

describe('citation errors are actionable', () => {
  it('lists the real offsets when a quote occurs more than once', () => {
    const book = library.import({ filename: 'c.txt', title: '歧义', base64: Buffer.from(text(), 'utf8').toString('base64') }).book;
    confirmAll(book);
    const jobId = library.beginReview({ bookKey: book.key, requestId: 'closure-3' }).job.id;
    for (let offset = 0; ; ) {
      const page = library.reviewMaterials({ jobId, kind: 'ranges', offset, limit: 5 });
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(() => library.finishReview({ jobId, title: 't', text: 'x'.repeat(120), episodeIds: [], evidence: [{ segmentId: 0, quote: '潮水打在礁石上。' }] }))
      .toThrow(/occurs \d+ times[\s\S]*absolute offsets/);
  });

  it('tells the model what a wrong start should be', () => {
    const book = library.import({ filename: 'd.txt', title: '偏移', base64: Buffer.from(text(), 'utf8').toString('base64') }).book;
    confirmAll(book);
    const jobId = library.beginReview({ bookKey: book.key, requestId: 'closure-4' }).job.id;
    for (let offset = 0; ; ) {
      const page = library.reviewMaterials({ jobId, kind: 'ranges', offset, limit: 5 });
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(() => library.finishReview({ jobId, title: 't', text: 'x'.repeat(120), episodeIds: [], evidence: [{ segmentId: 0, quote: realQuote(book), start: 1 }] }))
      .toThrow(/absolute offset|does occur at/);
  });

  it('explains the episodeIds contract instead of a bare length error', () => {
    const book = library.import({ filename: 'e.txt', title: '参数', base64: Buffer.from(text(), 'utf8').toString('base64') }).book;
    confirmAll(book);
    const jobId = library.beginReview({ bookKey: book.key, requestId: 'closure-5' }).job.id;
    for (let offset = 0; ; ) {
      const page = library.reviewMaterials({ jobId, kind: 'ranges', offset, limit: 5 });
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(() => library.finishReview({ jobId, title: 't', text: 'x'.repeat(120), episodeIds: 'nope' as unknown as string[], evidence: [{ segmentId: 0, quote: realQuote(book) }] }))
      .toThrow(/episodeIds must be an array/);
  });
});
