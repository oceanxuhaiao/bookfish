import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { Sources } from '../src/sources.ts';
import { SerialSync } from '../src/serial-sync.ts';
import { fixture, ROOT } from './fixtures/biquge.ts';
import { CONTROLLED_BOOK_URL, ControlledAdapter, controlledCatalog, controlledChapter, controlledLink } from './helpers/serial-adapter.ts';

let dir: string;
let stores: Library[];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bookfish-voice-source-')); stores = []; });
afterEach(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
function open() { const store = new Library({ dataDir: dir }); stores.push(store); store.open(); return store; }

describe('voice cached-end chapter fetching', () => {
  it('appends the next whole chapter without advancing the confirmed frontier', async () => {
    const f = fixture(); const store = open(); const service = new Sources(store, f.get);
    const imported = await service.resolve(ROOT); store.select(imported.book!.key);
    expect(store.status().current!.source!.cachedChapters).toBe(1);
    expect(store.status().current!.confirmedSegments).toBe(0);
    // The original flow cannot fetch yet: it waits for the confirmed frontier.
    expect(store.sourceDemand()?.needsNext).toBe(false);
    // The voice flow is keyed to the cached end.
    expect(store.voiceSourceDemand()?.needsNext).toBe(true);

    await service.ensureNextCached();
    expect(store.status().current!.source!.cachedChapters).toBe(2);
    expect(store.status().current!.confirmedSegments).toBe(0);
    expect(store.status().current!.confirmedChars).toBe(0);

    await service.ensureNextCached();
    expect(store.status().current!.source!.cachedChapters).toBe(3);
    expect(store.voiceSourceDemand()?.needsNext).toBe(false);
    const requests = f.requests.length;
    await service.ensureNextCached();
    expect(f.requests.length).toBe(requests);
  });

  it('coalesces concurrent voice fetches at the same cache end', async () => {
    const f = fixture(); const store = open(); const service = new Sources(store, f.get);
    const imported = await service.resolve(ROOT); store.select(imported.book!.key);
    await Promise.all([service.ensureNextCached(), service.ensureNextCached()]);
    expect(store.status().current!.source!.cachedChapters).toBe(2);
    expect(f.requests.filter(url => url === ROOT + '2/')).toHaveLength(1);
  });

  it('refuses to fetch while paused and never commits a cancelled fetch', async () => {
    const f = fixture(); const store = open(); const service = new Sources(store, f.get);
    const imported = await service.resolve(ROOT); store.select(imported.book!.key);
    store.setPaused(true);
    await expect(service.ensureNextCached()).rejects.toMatchObject({ code: 'cancelled' });
    expect(store.status().current!.source!.cachedChapters).toBe(1);
    expect(store.status().current!.confirmedSegments).toBe(0);
  });

  it('returns no voice demand for local books', async () => {
    const store = open();
    const imported = store.import({ filename: 'local.txt', title: '本地', base64: Buffer.from('本地正文。'.repeat(50)).toString('base64') });
    store.select(imported.book.key);
    expect(store.voiceSourceDemand()).toBeNull();
  });

  it('leaves serial books to the existing SerialSync flow', async () => {
    const links = [1, 2, 3].map((n) => controlledLink(n));
    const adapter = new ControlledAdapter(controlledCatalog(links), links.map(link => controlledChapter(link, `第${link.id}章正文。`.repeat(120))));
    const store = open();
    const sync = new SerialSync(store, { allowNetwork: () => true, adapter: () => adapter, now: () => 1000000, jobsFile: join(dir, 'serial-jobs.json') });
    sync.start();
    try {
      const preview = await sync.preview(adapter.id, CONTROLLED_BOOK_URL);
      const result = sync.subscribe(preview.token, { intervalMinutes: 60 });
      await sync.wait(result.jobId);
      store.select(result.bookKey);
      expect(store.voiceSourceDemand()).toBeNull();
      expect(store.sourceDemand()).toBeNull();
      expect(store.status().current!.source!.cachedChapters).toBe(3);
    } finally { sync.stop(); }
  });
});