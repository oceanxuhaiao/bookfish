import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Library } from '../src/library.ts';
import { ReviewFlow } from '../src/review-flow.ts';
import { BOOKFISH_DEFAULTS } from '../src/config.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { completed, REVIEW_MAX_SEGMENTS } from '../src/reviews.ts';
import type { WorldHost } from 'cortico/core/types.ts';
let dir: string, lib: Library, time: number, key: string, episodeId: string;
function readAll(episodes = true) {
  for (;;) { const t = lib.readNext(); if (t.complete) break;
    const quote = t.segment.text.includes('小鱼把灯留下。') ? '小鱼把灯留下。' : '小鱼回家了。';
    const result = lib.finish({ ...t, understanding: quote, ...(episodes ? { episode: { trigger: quote, interpretation: '合成记录：我喜欢她留下灯', reason: '灯能照亮后来的人', evidence: [{ segmentId: t.segmentId, quote }] } } : {}) });
    episodeId = result.receipt.episodeId ?? episodeId;
  }
}
function begin(id = 'review-one') { return lib.beginReview({ bookKey: key, requestId: id }).job; }
function materials(id: string) { for (const kind of ['ranges', 'episodes']) { let offset = 0; for (;;) { const p = lib.reviewMaterials({ jobId: id, kind, offset, limit: 1 }); if (p.nextOffset === null) break; offset = p.nextOffset; } } }
function article(jobId: string) { return { jobId, title: '灯留下了，人继续走', text: '这篇合成测试短篇让我注意到一件很小的事：小鱼没有把灯一起带走。原文写她把灯留下，我在阅读记录里写了喜欢这份照顾，因为灯能照亮后来的人。现在回看，离开与留下并不矛盾；她回家了，光还在。这个解释是现在写读后感的说法，不该被当成当时额外保存的心理活动。故事很短，人物也不多，我不替未交代的后来安排结局。', episodeIds: [episodeId], evidence: [{ segmentId: 0, quote: '小鱼把灯留下。' }] }; }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-review-')); time = Date.parse('2026-11-07T03:00:00Z'); lib = new Library({ dataDir: dir, now: () => time }); lib.open();
  key = lib.import({ filename: 'story.md', title: '合成短篇', base64: Buffer.from('# 灯\n小鱼把灯留下。\n# 家\n小鱼回家了。').toString('base64') }).book.key; lib.select(key);
});
afterEach(() => { lib.close(); rmSync(dir, { recursive: true, force: true }); });
describe('full-book articles, evidence and immutable versions', () => {
  it('rejects partial reading and remote cached prefixes or ongoing snapshots', () => {
    expect(() => begin()).toThrow(/fully/); const t = lib.readNext(); if (t.complete) throw new Error('fixture'); lib.finish({ ...t, understanding: '第一章' }); expect(() => begin()).toThrow(/fully/);
    const local = JSON.parse(JSON.parse(lib.export()).payload).books[0]; local.frontier = local.book.segments.length;
    local.book.remote = { cache: [{}], catalog: { chapters: [{}, {}], publicationStatus: 'finished' } }; expect(completed(local)).toBe(false);
    local.book.remote.cache.push({}); local.book.remote.catalog.publicationStatus = 'ongoing'; expect(completed(local)).toBe(false);
    local.book.remote.catalog.publicationStatus = 'unknown'; expect(completed(local)).toBe(false);
  });
  it('requires all range and episode pages; malformed quotes never save an article', () => {
    readAll(); const j = begin(); expect(() => lib.finishReview(article(j.id))).toThrow(/all ranges/);
    lib.reviewMaterials({ jobId: j.id, kind: 'ranges', limit: 5 }); expect(() => lib.finishReview(article(j.id))).toThrow(/all ranges/);
    lib.reviewMaterials({ jobId: j.id, kind: 'episodes', limit: 5 });
    expect(() => lib.finishReview({ ...article(j.id), evidence: [{ segmentId: 0, quote: '假的句子' }] })).toThrow(/match/);
    expect(lib.reviews().versions).toHaveLength(0); expect(lib.finishReview(article(j.id)).review.version).toBe(1);
  });
  it('handles identical retries and preserves old versions when a new article is written', () => {
    readAll(); const j = begin(); materials(j.id); const one = lib.finishReview(article(j.id)); expect(lib.finishReview(article(j.id)).duplicate).toBe(true);
    expect(() => lib.finishReview({ ...article(j.id), title: '覆盖旧版' })).toThrow(/match/);
    const next = begin('review-two'); materials(next.id); const two = lib.finishReview({ ...article(next.id), title: '第二次回看灯光' });
    expect(two.review).toMatchObject({ version: 2, previousId: one.review.id }); expect(lib.review(one.review.id).review).toEqual(one.review);
  });
  it('records failures and requires explicit fresh request ids, retaining previous articles', () => {
    readAll(); const j = begin(); lib.failReview({ jobId: j.id, reason: '受控模型失败' });
    expect(begin().status).toBe('failed'); expect(() => lib.reviewMaterials({ jobId: j.id, kind: 'ranges' })).toThrow(/stale/);
    const retry = begin('retry'); materials(retry.id); const saved = lib.finishReview(article(retry.id)); expect(saved.review.version).toBe(1);
    expect(() => lib.failReview({ jobId: retry.id, reason: '失败' })).toThrow(/cannot/);
  });
  it('invalidates pending jobs on pause, switching, remount and expiration', () => {
    readAll(); const j = begin(); lib.setPaused(true); expect(lib.reviews().jobs[0].status).toBe('cancelled'); lib.setPaused(false);
    expect(() => lib.finishReview(article(j.id))).toThrow(/stale/); const next = begin('second'); time += 30 * 60000;
    expect(() => lib.reviewMaterials({ jobId: next.id, kind: 'ranges' })).toThrow(/expired/); const retry = begin('third'); lib.close(); lib.open();
    expect(lib.reviews().jobs.find(j => j.id === retry.id)?.status).toBe('cancelled');
  });
  it('requires a coherent note snapshot and accepts later new versions without changing old ones', () => {
    readAll(); const j = begin(); materials(j.id); const saved = lib.finishReview(article(j.id));
    const next = begin('new'); lib.reflect({ bookKey: key, requestId: 'later', episode: { trigger: '灯', interpretation: '新反思', evidence: [{ segmentId: 0, quote: '小鱼把灯留下。' }] } });
    expect(() => lib.reviewMaterials({ jobId: next.id, kind: 'episodes' })).toThrow(/stale/);
    lib.close(); lib.open(); expect(lib.review(saved.review.id).review).toEqual(saved.review);
  });
  it('does not invent old moods or reasons when only legacy receipts exist', () => {
    readAll(false); const j = begin(); const notes = lib.reviewMaterials({ jobId: j.id, kind: 'episodes' }); expect(notes.items).toEqual([]);
    materials(j.id); const r = lib.finishReview({ ...article(j.id), episodeIds: [] }).review;
    expect(r.coverage).toMatchObject({ episodes: 0, rangesWithoutEpisode: 2 }); expect(lib.journal().mood).toBeNull();
  });
  it('restores every article/version and rejects tampered quotes or version chains', () => {
    readAll(); const j = begin(); materials(j.id); const saved = lib.finishReview(article(j.id)).review; const backup = lib.export(); lib.clear(); lib.restore(backup);
    expect(lib.review(saved.id).review).toEqual(saved); lib.clear(); const env = JSON.parse(backup), state = JSON.parse(env.payload); state.reviews[0].evidence[0].quote = '假的';
    writeFileSync(lib.file, JSON.stringify(state)); lib.close(); expect(() => lib.open()).toThrow(/match/);
  });
  it('migrates schema2 without fabricating jobs or articles and deletes articles with their book', () => {
    readAll(); const logical=JSON.parse(lib.export()).payload;lib.close(); const old = JSON.parse(logical); old.schema = 2; delete old.reviews; delete old.reviewJobs; writeFileSync(lib.file, JSON.stringify(old)); lib.open();
    expect(lib.reviews().versions).toEqual([]); expect(JSON.parse(readFileSync(lib.file, 'utf8')).schema).toBe(6);
    const j = begin(); materials(j.id); lib.finishReview(article(j.id)); lib.remove(key); expect(JSON.parse(JSON.parse(lib.export()).payload).reviews).toEqual([]);
  });
  it('rejects cross-book episodes, unknown jobs, invalid pages and concurrent jobs', () => {
    readAll(); const j = begin(); expect(() => begin('concurrent')).toThrow(/already/);
    expect(() => lib.reviewMaterials({ jobId: j.id, kind: 'ranges', offset: 999 })).toThrow(/range/);
    expect(() => lib.reviewMaterials({ jobId: j.id, kind: 'bad' })).toThrow(); expect(() => lib.failReview({ jobId: 'unknown', reason: 'no' })).toThrow();
    materials(j.id); expect(() => lib.finishReview({ ...article(j.id), episodeIds: ['other-revision'] })).toThrow(/exact/);
  });
  it('does not save an article or complete its job when the atomic commit fails', () => {
    lib.close(); let fail = false;
    lib = new Library({ dataDir: dir, now: () => time, write: (file, state) => { if (fail) throw new Error('controlled disk failure'); writeFileSync(file, JSON.stringify(state)); } }); lib.open();
    readAll(); const j = begin(); materials(j.id); fail = true;
    expect(() => lib.finishReview(article(j.id))).toThrow(/disk failure/); expect(lib.reviews().versions).toEqual([]); expect(lib.reviews().jobs[0].status).toBe('pending');
    fail = false; expect(lib.finishReview(article(j.id)).duplicate).toBe(false);
  });
});
describe('one optional completion opportunity', () => {
  it('waits for idle, emits once, does not retry a failed job and respects opt-out', async () => {
    readAll(); const cfg = { ...BOOKFISH_DEFAULTS, automaticReading: true }; const flow = new ReviewFlow(lib, cfg, () => time); const host = new FakeHost(); const queued: Parameters<WorldHost['pushDeferred']>[0][] = []; host.pushDeferred = e => queued.push(e);
    try { flow.start(host); flow.onRunPhase({ state: 'idle', running: [], enteredAt: '' }); time += 30000; cfg.automaticReview = false; flow.tick(); expect(queued).toHaveLength(0);
      cfg.automaticReview = true; flow.tick(); expect(queued).toHaveLength(1); expect(await queued[0].render()).toContain('bookfish_review(action="finish")');
      lib.failReview({ jobId: lib.reviews().jobs[0].id, reason: 'test' }); flow.tick(); expect(queued).toHaveLength(1); expect(await queued[0].render()).toBeNull();
    } finally { flow.stop(); }
  });
});

describe('launch review boundary', () => {
  it('rejects a full review above the launch segment limit', () => {
    const longDir = mkdtempSync(join(tmpdir(), 'bookfish-review-long-'));
    const longLib = new Library({ dataDir: longDir });
    longLib.open();
    try {
      const text = '小鱼把灯留下。'.repeat(400 * 150);
      const book = longLib.import({ filename: 'long.txt', title: '合成长篇', base64: Buffer.from(text).toString('base64') }).book;
      longLib.select(book.key);
      for (;;) { const task = longLib.readNext(); if (task.complete) break; longLib.finish({ ...task, understanding: '合成长篇的一段。' }); }
      expect(longLib.status().current?.totalSegments).toBeGreaterThan(REVIEW_MAX_SEGMENTS);
      expect(() => longLib.beginReview({ bookKey: book.key, requestId: 'long-review' })).toThrow(/Long-book full review is disabled/);
    } finally { longLib.close(); rmSync(longDir, { recursive: true, force: true }); }
  });
});