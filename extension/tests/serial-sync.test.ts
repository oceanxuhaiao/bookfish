import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { SerialSync } from '../src/serial-sync.ts';
import { SourceError } from '../src/source-types.ts';
import { CONTROLLED_BOOK_URL, ControlledAdapter, controlledCatalog, controlledChapter, controlledLink } from './helpers/serial-adapter.ts';

let dir: string, lib: Library, adapter: ControlledAdapter, sync: SerialSync, now: number, network: boolean;
const links = [1, 2, 3, 4, 5].map((n) => controlledLink(n));
const bodies = (items = links) => items.map((link) => controlledChapter(link, `第${link.id}章的正文。`.repeat(120)));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-serial-sync-')); lib = new Library({ dataDir: dir, now: () => now }); lib.open(); now = 1000000; network = true;
  adapter = new ControlledAdapter(controlledCatalog(links), bodies());
  sync = new SerialSync(lib, { allowNetwork: () => network, adapter: () => adapter, now: () => now, jobsFile: join(dir, 'serial-jobs.json') }); sync.start();
});
afterEach(() => { sync.stop(); lib.close(); rmSync(dir, { recursive: true, force: true }); });
async function subscribe(intervalMinutes = 60) {
  const preview = await sync.preview(adapter.id, CONTROLLED_BOOK_URL);
  const result = sync.subscribe(preview.token, { intervalMinutes });
  const job = await sync.wait(result.jobId);
  return { ...result, job };
}
describe('serial sync transaction, cancellation and recovery', () => {
  it('creates a subscription, fetches a bounded first batch and keeps a stable key', async () => {
    const { bookKey, job } = await subscribe();
    expect(job.status).toBe('succeeded');
    expect(job.added).toBe(5);
    const book = lib.list().find((b) => b.key === bookKey)!;
    expect(book.serial!.cachedChapters).toBe(5);
    expect(book.key).toBe(bookKey);
    expect(book.serial!.contentVersion).toBe(2);
    expect(lib.serialSubscription(bookKey)!.subscription.enabled).toBe(true);
    expect(lib.serialSubscription(bookKey)!.subscription.lastSuccessfulCheckAt).toBeTruthy();
    expect(JSON.stringify(sync.status()).length).toBeLessThan(4096);
  });
  it('records no_change without growing contentVersion or reading chapters again', async () => {
    const { bookKey } = await subscribe();
    const before = lib.serialSubscription(bookKey)!, reads = adapter.chapterCalls;
    const { jobId } = sync.check(bookKey); const job = await sync.wait(jobId);
    expect(job.status).toBe('succeeded'); expect(job.added).toBe(0);
    expect(lib.serialSubscription(bookKey)!.contentVersion).toBe(before.contentVersion);
    expect(adapter.chapterCalls).toBe(reads);
  });
  it('appends only the new tail and preserves confirmed progress and old bytes', async () => {
    const { bookKey } = await subscribe();
    lib.select(bookKey);
    for (let i = 0; i < 2; i++) { const t = lib.readNext(); if (t.complete) break; lib.finish({ ...t, understanding: '合成追更' }); }
    const frontier = lib.status().current!.confirmedSegments, text = lib.reread(bookKey, 0).segment.text;
    const oldVersion = lib.serialSubscription(bookKey)!.contentVersion;
    const link6 = controlledLink(6); adapter.setCatalog(controlledCatalog([...links, link6])); adapter.setChapter(controlledChapter(link6, '第六章正文。'.repeat(120)));
    const { jobId } = sync.check(bookKey); const job = await sync.wait(jobId);
    expect(job.status).toBe('succeeded'); expect(job.added).toBe(1);
    const book = lib.list().find((b) => b.key === bookKey)!;
    expect(book.key).toBe(bookKey); expect(book.confirmedSegments).toBe(frontier);
    expect(lib.reread(bookKey, 0).segment.text).toBe(text);
    expect(lib.serialSubscription(bookKey)!.contentVersion).toBe(oldVersion + 1);
  });
  it('deduplicates concurrent checks into one job', async () => {
    const { bookKey } = await subscribe();
    let release!: () => void; adapter.gate = new Promise<void>((resolve) => { release = resolve; });
    const first = sync.check(bookKey), second = sync.check(bookKey);
    expect(second.duplicate).toBe(true); expect(second.jobId).toBe(first.jobId);
    release(); await sync.wait(first.jobId);
    adapter.gate = null;
  });
  it('cancels before commit without adding visible chapters', async () => {
    const { bookKey } = await subscribe();
    const before = lib.list().find((b) => b.key === bookKey)!, version = lib.serialSubscription(bookKey)!.contentVersion;
    const link6 = controlledLink(6); adapter.setCatalog(controlledCatalog([...links, link6])); adapter.setChapter(controlledChapter(link6, '第六章正文。'.repeat(120)));
    let release!: () => void; adapter.gate = new Promise<void>((resolve) => { release = resolve; });
    const { jobId } = sync.check(bookKey);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelled = sync.cancel(jobId);
    release();
    const job = await sync.wait(jobId);
    expect(cancelled.cancelled).toBe(true); expect(job.status).toBe('cancelled');
    const after = lib.list().find((b) => b.key === bookKey)!;
    expect(after.serial!.cachedChapters).toBe(before.serial!.cachedChapters);
    expect(lib.serialSubscription(bookKey)!.contentVersion).toBe(version);
  });
  it('commits the verified prefix when a later chapter fails, then retries from that chapter', async () => {
    const { bookKey } = await subscribe();
    const link6 = controlledLink(6), link7 = controlledLink(7);
    adapter.setCatalog(controlledCatalog([...links, link6, link7]));
    adapter.setChapter(controlledChapter(link6, '第六章正文。'.repeat(120)));
    adapter.setChapter(controlledChapter(link7, '第七章正文。'.repeat(120)));
    adapter.chapterError = (index) => index === 6 ? new SourceError('temporary', 'controlled 503') : null;
    const first = await sync.wait(sync.check(bookKey).jobId);
    expect(first.status).toBe('failed'); expect(first.added).toBe(1);
    expect(lib.serialSubscription(bookKey)!.layout.length).toBe(6);
    expect(lib.serialSubscription(bookKey)!.subscription.failures).toBe(1);
    expect(lib.serialSubscription(bookKey)!.subscription.backoffUntil).toBeTruthy();
    adapter.chapterError = null;
    const second = await sync.wait(sync.check(bookKey).jobId);
    expect(second.status).toBe('succeeded'); expect(second.added).toBe(1);
    expect(lib.serialSubscription(bookKey)!.layout.length).toBe(7);
  });
  it('does not commit when the second catalog read conflicts', async () => {
    const { bookKey } = await subscribe();
    const before = lib.serialSubscription(bookKey)!, version = before.contentVersion;
    const good = controlledCatalog([...links, controlledLink(6)]);
    const bad = controlledCatalog([{ ...controlledLink(1), title: '第一章被改写' }, ...links.slice(1), controlledLink(6)]);
    adapter.catalogs = [good, bad];
    adapter.setChapter(controlledChapter(controlledLink(6), '第六章正文。'.repeat(120)));
    const job = await sync.wait(sync.check(bookKey).jobId);
    expect(job.status).toBe('conflict');
    expect(lib.serialSubscription(bookKey)!.contentVersion).toBe(version);
    expect(lib.serialSubscription(bookKey)!.subscription.enabled).toBe(false);
    expect(lib.list().find((b) => b.key === bookKey)!.serial!.cachedChapters).toBe(5);
  });
  it('fails closed on an incomplete catalog or disabled network', async () => {
    const { bookKey } = await subscribe();
    const version = lib.serialSubscription(bookKey)!.contentVersion;
    adapter.setCatalog(controlledCatalog([...links, controlledLink(6)], 'ongoing', false));
    const job = await sync.wait(sync.check(bookKey).jobId);
    expect(job.status).toBe('failed');
    expect(lib.serialSubscription(bookKey)!.contentVersion).toBe(version);
    sync.stop();
    const offline = new SerialSync(lib, { allowNetwork: () => false, adapter: () => adapter, jobsFile: join(dir, 'serial-jobs.json') });
    offline.start();
    try {
      expect(() => offline.check(bookKey, 'manual')).toThrow(/网络访问已关闭/);
      expect(lib.serialSubscription(bookKey)!.contentVersion).toBe(version);
    } finally { offline.stop(); }
  });
  it('does not resurrect a book deleted while a job is running', async () => {
    const { bookKey } = await subscribe();
    const link6 = controlledLink(6); adapter.setCatalog(controlledCatalog([...links, link6])); adapter.setChapter(controlledChapter(link6, '第六章正文。'.repeat(120)));
    let release!: () => void; adapter.gate = new Promise<void>((resolve) => { release = resolve; });
    const { jobId } = sync.check(bookKey);
    await new Promise((resolve) => setTimeout(resolve, 20));
    lib.remove(bookKey); release();
    const job = await sync.wait(jobId);
    expect(['failed', 'cancelled']).toContain(job.status);
    expect(lib.list().some((book) => book.key === bookKey)).toBe(false);
  });
  it('stops before commit when the global network switch is turned off mid-check', async () => {
    const { bookKey } = await subscribe();
    const version = lib.serialSubscription(bookKey)!.contentVersion;
    const link6 = controlledLink(6); adapter.setCatalog(controlledCatalog([...links, link6])); adapter.setChapter(controlledChapter(link6, '第六章正文。'.repeat(120)));
    adapter.afterCatalog = () => { network = false; };
    const job = await sync.wait(sync.check(bookKey).jobId);
    adapter.afterCatalog = null;
    expect(job.status).toBe('failed');
    expect(lib.serialSubscription(bookKey)!.contentVersion).toBe(version);
    expect(lib.serialSubscription(bookKey)!.layout.length).toBe(5);
  });
  it('marks an interrupted job as interrupted after restart instead of replaying it', async () => {
    const { bookKey } = await subscribe();
    let release!: () => void; adapter.gate = new Promise<void>((resolve) => { release = resolve; });
    const { jobId } = sync.check(bookKey);
    await new Promise((resolve) => setTimeout(resolve, 20));
    sync.stop(); release();
    const restarted = new SerialSync(lib, { allowNetwork: () => true, adapter: () => adapter, jobsFile: join(dir, 'serial-jobs.json') });
    restarted.start();
    try {
      const saved = restarted.jobsFor(bookKey).find((job) => job.jobId === jobId);
      expect(saved?.status).toBe('interrupted');
      expect(lib.serialSubscription(bookKey)!.contentVersion).toBe(2);
    } finally { restarted.stop(); }
  });
});
