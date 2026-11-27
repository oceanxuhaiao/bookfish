import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library } from '../src/library.ts';
import { Sources } from '../src/sources.ts';
import { VoiceCoordinator } from '../src/voice/coordinator.ts';
import { catalogHash } from '../src/biquge.ts';
import { digest } from '../src/books.ts';
import type { ChapterLink, SourceCatalog } from '../src/source-types.ts';
import { fixture, ROOT } from './fixtures/biquge.ts';
import { deferred, makeWav, waitFor } from './helpers/voice-fixtures.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bookfish-voice-remote-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function syntheticCatalog(count: number, status: 'finished' | 'ongoing' = 'ongoing'): SourceCatalog {
  const chapters: ChapterLink[] = Array.from({ length: count }, (_, index) => ({
    title: `第${index + 1}章`, url: `${ROOT}${index + 1}/`,
  }));
  const catalog: SourceCatalog = { adapter: 'biquge-02345-v1', bookUrl: ROOT,
    title: '百章合成书', author: '测试作者', declaredTotal: count, chapters,
    publicationStatus: status, complete: true, pageCount: 1, fetchedAt: new Date().toISOString(), hash: '' };
  catalog.hash = catalogHash(catalog);
  return catalog;
}

function cachedChapter(catalog: SourceCatalog, index: number) {
  const text = `第${index + 1}章正文。`.repeat(10);
  return {
    index, text, hash: digest(text), fetchedAt: new Date().toISOString(),
    pages: [{ url: catalog.chapters[index]!.url, hash: 'a'.repeat(64) }],
  };
}

function cacheChapter(lib: Library, key: string, catalog: SourceCatalog, index: number) {
  const generation = lib.generation();
  lib.cacheChapter(key, generation, cachedChapter(catalog, index));
}

function confirmAll(lib: Library) {
  while (lib.status().current!.confirmedSegments < lib.status().current!.totalSegments) {
    const task = lib.readNext();
    if (task.complete) break;
    lib.finish({ taskId: task.taskId, bookKey: task.bookKey, segmentId: task.segmentId, understanding: '' });
  }
}

describe('voice readiness at a cached end', () => {
  it('a 100-chapter catalog with 10 cached chapters is waiting_content, not caught_up', () => {
    const lib = new Library({ dataDir: join(dir, 'snapshot') }); lib.open();
    try {
      const catalog = syntheticCatalog(100, 'ongoing');
      const generation = lib.generation();
      const imported = lib.importCatalog(catalog, generation, cachedChapter(catalog, 0));
      lib.select(imported.book.key);
      for (let index = 1; index < 10; index += 1) cacheChapter(lib, imported.book.key, catalog, index);
      expect(lib.status().current!.source!.cachedChapters).toBe(10);
      expect(lib.voiceSnapshot()!.readiness).toBe('backlog');
      confirmAll(lib);
      expect(lib.status().current!.confirmedSegments).toBe(lib.status().current!.totalSegments);
      const snap = lib.voiceSnapshot()!;
      expect(snap.complete).toBe(false);
      expect(snap.readiness).toBe('waiting_content');
      expect(lib.voiceSourceDemand()?.needsNext).toBe(true);
    } finally { lib.close(); }
  });

  it('an all-cached ongoing catalog is caught_up, and a finished one is complete', () => {
    for (const status of ['ongoing', 'finished'] as const) {
      const lib = new Library({ dataDir: join(dir, `snapshot-${status}`) }); lib.open();
      try {
        const catalog = syntheticCatalog(2, status);
        const generation = lib.generation();
        const imported = lib.importCatalog(catalog, generation, cachedChapter(catalog, 0));
        lib.select(imported.book.key);
        cacheChapter(lib, imported.book.key, catalog, 1);
        confirmAll(lib);
        const snap = lib.voiceSnapshot()!;
        expect(snap.readiness).toBe('caught_up');
        expect(snap.complete).toBe(status === 'finished');
        expect(lib.voiceSourceDemand()?.needsNext).toBe(false);
      } finally { lib.close(); }
    }
  });
});

describe('real Library + Sources + VoiceCoordinator at a cached end', () => {
  it('fetches the next whole chapter and keeps confirmed progress at zero', async () => {
    const f = fixture();
    const lib = new Library({ dataDir: join(dir, 'joint') }); lib.open();
    const service = new Sources(lib, f.get);
    const synthCalls: string[] = [];
    const played: number[] = [];
    let coordinator: VoiceCoordinator | undefined;
    try {
      const imported = await service.resolve(ROOT);
      lib.select(imported.book!.key);
      expect(lib.status().current!.source!.cachedChapters).toBe(1);
      expect(lib.status().current!.confirmedSegments).toBe(0);
      const generation = lib.generation();
      coordinator = new VoiceCoordinator({
        port: {
          snapshot: () => lib.voiceSnapshot(),
          segments: (from, max) => lib.voiceSegments(from, max),
          pendingTask: () => lib.voicePendingTask(),
        },
        enabled: () => true,
        secret: () => 'test-key',
        dataDir: dir,
        fetchNext: signal => service.ensureNextCached(signal),
        synthesize: async (text) => { synthCalls.push(text); return makeWav(); },
        play: async () => { played.push(1); },
        pollMs: 0,
      });
      coordinator.attach();
      await coordinator.start();
      await waitFor(() => lib.status().current!.source!.cachedChapters === 3 && coordinator!.status().phase === 'waiting_content');
      expect(lib.status().current!.confirmedSegments).toBe(0);
      expect(lib.status().current!.confirmedChars).toBe(0);
      expect(lib.status().pending).toBeNull();
      expect(lib.generation()).toBe(generation);
      expect(synthCalls.join('')).toContain('第3章');
      expect(played.length).toBeGreaterThanOrEqual(3);
      expect(coordinator.status().voicedUpTo).toBeGreaterThanOrEqual(lib.status().current!.totalSegments - 1);
    } finally {
      await coordinator?.dispose();
      lib.close();
    }
  });

  it('aborts an in-flight next-chapter fetch on pause and does not commit it', async () => {
    const f = fixture();
    const lib = new Library({ dataDir: join(dir, 'pause') }); lib.open();
    const fetchStarted = deferred();
    const block = deferred();
    const slowGet = async (url: string, signal?: AbortSignal) => {
      if (url === ROOT + '2/') {
        fetchStarted.resolve();
        await Promise.race([block.promise, new Promise<void>((_, reject) => {
          if (signal?.aborted) { reject(new Error('aborted')); return; }
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })]);
      }
      return f.get(url, signal);
    };
    const service = new Sources(lib, slowGet as typeof f.get);
    let coordinator: VoiceCoordinator | undefined;
    try {
      const imported = await service.resolve(ROOT);
      lib.select(imported.book!.key);
      coordinator = new VoiceCoordinator({
        port: { snapshot: () => lib.voiceSnapshot(), segments: (from, max) => lib.voiceSegments(from, max) },
        enabled: () => true, secret: () => 'test-key', dataDir: dir,
        fetchNext: signal => service.ensureNextCached(signal),
        synthesize: async () => makeWav(), play: async () => {}, pollMs: 0,
      });
      coordinator.attach();
      await coordinator.start();
      await fetchStarted.promise;
      expect(lib.status().current!.source!.cachedChapters).toBe(1);
      lib.setPaused(true);
      await coordinator.revalidate();
      expect(coordinator.status()).toMatchObject({ phase: 'idle', bookKey: null, voicedUpTo: null });
      expect(lib.status().current!.source!.cachedChapters).toBe(1);
      expect(lib.status().current!.confirmedSegments).toBe(0);
    } finally {
      block.resolve();
      await coordinator?.dispose();
      lib.close();
    }
  });
});