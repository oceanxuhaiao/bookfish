/**
 * R2 阶段 3：整本评论"材料读取期间失效"的真实 Handler + 存储层集成测试。
 *
 * 失效机制（源码事实，未新增状态字段）：
 *   beginReview 记录 digest([bookKey, frontier, sourceHash, episodeIds])
 *   pendingJob 在每次 materials/finish 前重算，不一致即 stale。
 * 注意实现顺序：finishReview 先校验正文格式与引用，再校验快照，
 * 所以下面的失效用例都提供"格式完全合法"的正文，确保命中的是快照校验。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';

let dir: string;
let library: Library;
let clock: number;
let bookKey: string;

const EVIDENCE = { segmentId: 0, quote: '黎望把灯芯剪短了一点' };
const LONG = '这一段我读得很慢，灯芯剪短的时候她没有解释，风一直从东边来，像在数时间。'.repeat(4);

beforeEach(() => {
  clock = 1_000_000;
  dir = mkdtempSync(join(tmpdir(), 'bookfish-review-r2-'));
  library = new Library({ dataDir: dir, now: () => clock });
  library.open();
  const text = '黎望把灯芯剪短了一点。' + '风从东边来。'.repeat(20) + '沈岸把木箱搬到灯塔下面。' + '雾散了。'.repeat(12);
  bookKey = library.import({ filename: 'r.txt', title: '失效样本', base64: Buffer.from(text, 'utf8').toString('base64') }).book.key;
  library.select(bookKey);
  readWholeBook();
});

afterEach(() => {
  library.close();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 句柄 */ }
});

function readWholeBook() {
  for (;;) {
    const batch = library.readNext(1) as any;
    if (!batch?.segments?.length) break;
    for (const item of batch.segments) {
      library.finish({ taskId: item.taskId, bookKey, segmentId: item.segmentId, understanding: '读过了。' });
    }
  }
}

function readAllMaterials(jobId: string) {
  let offset = 0;
  for (;;) {
    const page = library.reviewMaterials({ jobId, kind: 'ranges', offset, limit: 5 }) as any;
    if (!page.nextOffset) break;
    offset = page.nextOffset;
  }
  offset = 0;
  for (;;) {
    const page = library.reviewMaterials({ jobId, kind: 'episodes', offset, limit: 5 }) as any;
    if (!page.nextOffset) break;
    offset = page.nextOffset;
  }
}

function begin() {
  return (library.beginReview({ bookKey, requestId: `req-${Math.random().toString(36).slice(2, 8)}` }) as any).job;
}

function episodeIds() {
  return ((library.journal(bookKey) as any).items ?? []).map((entry: any) => entry.id);
}

function args(job: any, extra: Record<string, unknown> = {}) {
  return { jobId: job.id, title: '读完之后', text: LONG, episodeIds: episodeIds(), evidence: [EVIDENCE], ...extra };
}

function addReflection(requestId: string) {
  clock += 60_000;
  return library.reflect({ bookKey, requestId, episode: { trigger: '读到一半', interpretation: '先记下来。', evidence: [EVIDENCE] } }) as any;
}

describe('full-book review snapshot invalidation (real handlers + storage)', () => {
  it('completes normally when the snapshot never changes', () => {
    const job = begin();
    readAllMaterials(job.id);
    const saved = library.finishReview(args(job)) as any;
    expect(saved.duplicate).toBe(false);
    expect(saved.review.version).toBe(1);
    expect((library.reviews(bookKey) as any).versions).toHaveLength(1);
  });

  it('rejects finish after the episode set changes mid-read', () => {
    const job = begin();
    readAllMaterials(job.id);
    addReflection('mid-read-1');
    expect(() => library.finishReview(args(job))).toThrow(/stale, paused, expired or cancelled/);
    expect((library.reviews(bookKey) as any).versions).toHaveLength(0);
  });

  it('rejects further material pages once the snapshot is stale', () => {
    const job = begin();
    library.reviewMaterials({ jobId: job.id, kind: 'ranges', offset: 0, limit: 1 });
    addReflection('stale-page-1');
    expect(() => library.reviewMaterials({ jobId: job.id, kind: 'ranges', offset: 1, limit: 1 })).toThrow(/stale/);
  });

  it('rejects the old snapshot after the selected book switches', () => {
    const job = begin();
    readAllMaterials(job.id);
    const other = library.import({ filename: 'o.txt', title: '另一本', base64: Buffer.from('另一本书的第一段。' + '潮声。'.repeat(30), 'utf8').toString('base64') }).book.key;
    library.select(other);
    expect(() => library.finishReview(args(job))).toThrow(/stale/);
  });

  it('does not save anything after invalidation', () => {
    const job = begin();
    readAllMaterials(job.id);
    addReflection('invalidate-save-1');
    try { library.finishReview(args(job)); } catch { /* 预期 */ }
    expect((library.reviews(bookKey) as any).versions).toHaveLength(0);
  });

  it('a fresh request after invalidation saves version 1, not a duplicate', () => {
    const stale = begin();
    readAllMaterials(stale.id);
    addReflection('invalidate-fresh-1');
    expect(() => library.finishReview(args(stale))).toThrow(/stale/);
    library.failReview({ jobId: stale.id, reason: 'snapshot went stale' });
    const fresh = begin();
    readAllMaterials(fresh.id);
    const saved = library.finishReview(args(fresh)) as any;
    expect(saved.review.version).toBe(1);
    expect((library.reviews(bookKey) as any).versions).toHaveLength(1);
  });

  it('repeating an identical finish returns the saved version without a new one', () => {
    const job = begin();
    readAllMaterials(job.id);
    const first = library.finishReview(args(job)) as any;
    const again = library.finishReview(args(job)) as any;
    expect(again.duplicate).toBe(true);
    expect(again.review.id).toBe(first.review.id);
    expect((library.reviews(bookKey) as any).versions).toHaveLength(1);
  });

  it('a failed job cannot be finished afterwards', () => {
    const job = begin();
    readAllMaterials(job.id);
    library.failReview({ jobId: job.id, reason: '用户取消' });
    expect(() => library.finishReview(args(job))).toThrow(/stale|failed|cancelled/);
    expect((library.reviews(bookKey) as any).versions).toHaveLength(0);
  });

  it('a saved review cannot be failed or overwritten', () => {
    const job = begin();
    readAllMaterials(job.id);
    library.finishReview(args(job));
    expect(() => library.failReview({ jobId: job.id, reason: '试图覆盖' })).toThrow(/cannot be failed or overwritten/);
  });
});
