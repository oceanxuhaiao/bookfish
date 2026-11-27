import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library } from '../src/library.ts';
import { Sources } from '../src/sources.ts';
import { fixture, ROOT } from './fixtures/biquge.ts';
import { deferred } from './helpers/voice-fixtures.ts';

let dir: string;
let lib: Library;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bookfish-voice-cancel-')); lib = new Library({ dataDir: dir }); lib.open(); });
afterEach(() => { lib.close(); rmSync(dir, { recursive: true, force: true }); });

function confirmAll() {
  while (lib.status().current!.confirmedSegments < lib.status().current!.totalSegments) {
    const task = lib.readNext();
    if (task.complete) break;
    lib.finish({ taskId: task.taskId, bookKey: task.bookKey, segmentId: task.segmentId, understanding: '' });
  }
}

async function prepare() {
  const f = fixture();
  const service = new Sources(lib, f.get);
  const imported = await service.resolve(ROOT);
  lib.select(imported.book!.key);
  confirmAll();
  expect(lib.sourceDemand()?.needsNext).toBe(true);
  expect(lib.voiceSourceDemand()?.needsNext).toBe(true);
  return { f, service };
}

function abortError(signal?: AbortSignal) {
  return new Promise<never>((_, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

describe('shared source fetch cancellation isolation', () => {
  it('voice first, reader joins, voice cancels: reader still succeeds and fetches once', async () => {
    const started = deferred();
    const gate = deferred();
    const signals: AbortSignal[] = [];
    const f = fixture();
    const slowGet = async (url: string, signal?: AbortSignal) => {
      if (url === ROOT + '2/') { signals.push(signal!); started.resolve(); await Promise.race([gate.promise, abortError(signal)]); }
      return f.get(url, signal);
    };
    const service = new Sources(lib, slowGet as typeof f.get);
    const imported = await service.resolve(ROOT); lib.select(imported.book!.key); confirmAll();
    const voiceAbort = new AbortController();
    const voice = service.ensureNextCached(voiceAbort.signal);
    await started.promise;
    const reader = service.ensureNext();
    await Promise.resolve();
    voiceAbort.abort();
    await expect(voice).rejects.toMatchObject({ code: 'cancelled' });
    expect(signals[0]!.aborted).toBe(false);
    gate.resolve();
    await expect(reader).resolves.toBeUndefined();
    expect(lib.status().current!.source!.cachedChapters).toBe(2);
    expect(f.requests.filter(url => url === ROOT + '2/')).toHaveLength(1);
  });

  it('reader first, voice joins, voice cancels: reader still succeeds and fetches once', async () => {
    const started = deferred();
    const gate = deferred();
    const signals: AbortSignal[] = [];
    const f = fixture();
    const slowGet = async (url: string, signal?: AbortSignal) => {
      if (url === ROOT + '2/') { signals.push(signal!); started.resolve(); await Promise.race([gate.promise, abortError(signal)]); }
      return f.get(url, signal);
    };
    const service = new Sources(lib, slowGet as typeof f.get);
    const imported = await service.resolve(ROOT); lib.select(imported.book!.key); confirmAll();
    const reader = service.ensureNext();
    await started.promise;
    const voiceAbort = new AbortController();
    const voice = service.ensureNextCached(voiceAbort.signal);
    await Promise.resolve();
    voiceAbort.abort();
    await expect(voice).rejects.toMatchObject({ code: 'cancelled' });
    gate.resolve();
    await expect(reader).resolves.toBeUndefined();
    expect(lib.status().current!.source!.cachedChapters).toBe(2);
    expect(f.requests.filter(url => url === ROOT + '2/')).toHaveLength(1);
  });

  it('all callers cancel: the shared request aborts and a later call can start fresh', async () => {
    const started = deferred();
    const gate = deferred();
    const signals: AbortSignal[] = [];
    const f = fixture();
    const slowGet = async (url: string, signal?: AbortSignal) => {
      if (url === ROOT + '2/' && signals.length === 0) {
        signals.push(signal!); started.resolve(); await Promise.race([gate.promise, abortError(signal)]);
      }
      return f.get(url, signal);
    };
    const service = new Sources(lib, slowGet as typeof f.get);
    const imported = await service.resolve(ROOT); lib.select(imported.book!.key); confirmAll();
    const a = new AbortController(); const b = new AbortController();
    const voice = service.ensureNextCached(a.signal);
    await started.promise;
    const reader = service.ensureNext(b.signal);
    await Promise.resolve();
    a.abort(); b.abort();
    await expect(voice).rejects.toMatchObject({ code: 'cancelled' });
    await expect(reader).rejects.toMatchObject({ code: 'cancelled' });
    expect(signals[0]!.aborted).toBe(true);
    expect(lib.status().current!.source!.cachedChapters).toBe(1);
    // A new caller creates a new task rather than reusing the aborted one.
    gate.resolve();
    await expect(service.ensureNextCached()).resolves.toBeUndefined();
    expect(lib.status().current!.source!.cachedChapters).toBe(2);
  });

  it('a late result after a generation change is not committed', async () => {
    const started = deferred();
    const gate = deferred();
    const f = fixture();
    const slowGet = async (url: string, signal?: AbortSignal) => {
      if (url === ROOT + '2/') { started.resolve(); await gate.promise; }
      return f.get(url, signal);
    };
    const service = new Sources(lib, slowGet as typeof f.get);
    const imported = await service.resolve(ROOT); lib.select(imported.book!.key); confirmAll();
    const reader = service.ensureNext();
    await started.promise;
    lib.setPaused(true); // generation change
    gate.resolve();
    await expect(reader).rejects.toMatchObject({ code: 'cancelled' });
    expect(lib.status().current!.source!.cachedChapters).toBe(1);
    expect(lib.status().current!.confirmedSegments).toBe(lib.status().current!.totalSegments);
  });

  it('a shared failure is reported once to both callers and can be retried fresh', async () => {
    const f = fixture(); f.pages.delete(ROOT + '2/');
    const service = new Sources(lib, f.get);
    const imported = await service.resolve(ROOT); lib.select(imported.book!.key); confirmAll();
    const [voice, reader] = await Promise.allSettled([service.ensureNextCached(), service.ensureNext()]);
    expect(voice.status).toBe('rejected');
    expect(reader.status).toBe('rejected');
    expect((voice as PromiseRejectedResult).reason).toMatchObject({ code: 'missing' });
    expect((reader as PromiseRejectedResult).reason).toMatchObject({ code: 'missing' });
    expect(f.requests.filter(url => url === ROOT + '2/')).toHaveLength(1);
    expect(lib.status().current!.source!.cachedChapters).toBe(1);
    f.pages.set(ROOT + '2/', fixtureChapter2());
    await expect(service.ensureNextCached()).resolves.toBeUndefined();
    expect(lib.status().current!.source!.cachedChapters).toBe(2);
  });
});

function fixtureChapter2() {
  return `<html><body><h1>第二章 归途-《合成测试小说》</h1><article class="font_max">第(1/1)页<br>海风吹过小屋，伙伴们沿着熟悉的小路慢慢回家，远处的灯光照着归途。这是第2章第1页的合成正文。<br>第(1/1)页</article><a id="next" href="${ROOT}3/">下一章</a></body></html>`;
}