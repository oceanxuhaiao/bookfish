import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Library } from '../src/library.ts';
import { digest } from '../src/books.ts';
import { newSerialRecord } from '../src/serial-types.ts';
import { CONTROLLED_BOOK_URL, ControlledAdapter, controlledCatalog, controlledChapter, controlledLink } from './helpers/serial-adapter.ts';

let dir: string, lib: Library;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bookfish-serial-review-')); lib = new Library({ dataDir: dir }); lib.open(); });
afterEach(() => { lib.close(); rmSync(dir, { recursive: true, force: true }); });
function serial(catalog: ReturnType<typeof controlledCatalog>) {
  return newSerialRecord({ serialId: randomUUID(), adapterId: 'controlled-serial-v1', sourceBookId: '/book/1/', bookUrl: CONTROLLED_BOOK_URL,
    capabilities: new ControlledAdapter(catalog).capabilities, authorization: 'allowed', authorizationNote: '受控原创源', catalog,
    enabled: false, intervalMinutes: 60, now: Date.now() });
}
function body(link: ReturnType<typeof controlledLink>, text: string, index: number) { return { ...controlledChapter(link, text), index }; }
describe('serial completion and historical review snapshots', () => {
  it('allows a full-book review only for a finished, fully cached serial and keeps it after a later append', () => {
    const link1 = controlledLink(1); const text1 = '小鱼把灯留在窗边，海风从门缝里吹进来。'.repeat(80);
    const cat1 = controlledCatalog([link1], 'finished');
    const created = lib.createSerial({ catalog: cat1, serial: serial(cat1), chapters: [{ index: 0, text: text1, hash: digest(text1), fetchedAt: new Date().toISOString(), pages: [{ url: link1.url, hash: digest('p1') }] }] }, lib.generation());
    const key = created.book.key; lib.select(key);
    const total = lib.status().current!.totalSegments;
    for (let i = 0; i < total; i++) { const t = lib.readNext(); if (t.complete) break; lib.finish({ ...t, understanding: '合成完读验证' }); }
    expect(lib.list().find((b) => b.key === key)!.complete).toBe(true);
    const job = lib.beginReview({ bookKey: key, requestId: 'serial-review-1' }).job;
    for (const kind of ['ranges', 'episodes'] as const) { let offset = 0; for (;;) { const page = lib.reviewMaterials({ jobId: job.id, kind, offset, limit: 2 }); if (page.nextOffset === null) break; offset = page.nextOffset; } }
    const first = lib.reread(key, 0).segment.text.slice(0, 20);
    const saved = lib.finishReview({ jobId: job.id, title: '读完这本连载', text: '这是一段足够长的合成读后感，用来验证连载完读后保存的文章不会因为后续追加章节而失去依据。'.repeat(3), episodeIds: [],
      evidence: [{ segmentId: 0, quote: first! }] });
    expect(saved.review.id).toBeTruthy();
    const link2 = controlledLink(2); const text2 = '第二天海面很安静。'.repeat(120);
    const cat2 = controlledCatalog([link1, link2], 'ongoing');
    const current = lib.serialSubscription(key)!;
    lib.commitSerialSync({ bookKey: key, expectedSubscriptionRevision: current.subscriptionRevision, expectedContentVersion: current.contentVersion,
      baseCatalogHash: cat1.hash, catalog: cat2, chapters: [{ index: 1, text: text2, hash: digest(text2), fetchedAt: new Date().toISOString(), pages: [{ url: link2.url, hash: digest('p2') }] }],
      publicationEvidence: { status: 'ongoing', source: 'controlled-serial-v1', observedAt: new Date().toISOString(), note: '' }, receipt: { jobId: randomUUID(), status: 'succeeded', error: null } });
    expect(lib.list().find((b) => b.key === key)!.complete).toBe(false);
    expect(() => lib.beginReview({ bookKey: key, requestId: 'serial-review-2' })).toThrow();
    lib.close(); lib.open();
    const versions = lib.reviews(key).versions;
    expect(versions.map((v) => v.id)).toContain(saved.review.id);
    expect(lib.review(saved.review.id).review.text).toContain('合成读后感');
  });
});
