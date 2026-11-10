import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BookfishWorld } from '../src/world.ts';
import { BOOKFISH_DEFAULTS } from '../src/config.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { assessNovelDownload, type CatalogChapter, type DownloadChapterFile } from '../src/novel-integrity.ts';
import type { NovelEngineLike } from '../src/novel-fetch.ts';
import type { NovelSearchCandidate } from '../src/novel-match.ts';
import type { NovelDownloadResult, NovelEngineAvailability } from '../src/novel-engine.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const candidate: NovelSearchCandidate = {
  title: '海边的信', author: '小鱼', url: 'https://www.biquge365.net/book/1/',
  source: { id: 8, name: '笔趣阁365' }, revision: 'abcdef1234567890', latestChapter: '第3章', lastUpdateTime: '11-09',
};
function catalog(): CatalogChapter[] {
  return [1, 2, 3].map((order) => ({ order, title: `第${order}章 海边来信`, url: `https://www.biquge365.net/chapter/1/${order}.html` }));
}
function files(): DownloadChapterFile[] {
  return catalog().map((chapter) => ({ order: chapter.order, title: chapter.title, text: `${chapter.title}\n\n　　${'海风吹过码头，小鱼取出一封信。'.repeat(8)}\n` }));
}

function fakeEngine(taskDir: string): NovelEngineLike {
  return {
    availability(): NovelEngineAvailability { return { available: true, engineDir: '/engine', version: '1.12.0', bridge: 'package' }; },
    async search() { return [candidate]; },
    async toc() { return catalog(); },
    async download(): Promise<NovelDownloadResult> { return { taskDir, downloadDir: join(taskDir, 'downloads'), files: files(), exitCode: 0, stderrTail: '' }; },
    preflight(identity, list) { return assessNovelDownload({ book: identity, catalog: list, files: [], catalogOnly: true }); },
  };
}

describe('World fetch-by-title integration', () => {
  it('search → queue → complete imports exactly once through the existing library', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bookfish-novel-world-')); dirs.push(dataDir);
    const taskDir = mkdtempSync(join(tmpdir(), 'bookfish-novel-task-')); dirs.push(taskDir);
    const world = new BookfishWorld({
      cfg: { ...BOOKFISH_DEFAULTS, allowNetwork: true },
      timezone: 'UTC', dataDir,
      novelEngine: fakeEngine(taskDir), novelPageProbe: null,
      novelWorkDir: join(dataDir, 'bookfish', 'novel-fetch'),
    });
    await world.start(new FakeHost());
    try {
      const invoke = world.webUi!().invoke!;
      const initial = await invoke('status', 'get', []) as { novel: { available: boolean; tasks: unknown[] } };
      expect(initial.novel.available).toBe(true);
      expect(initial.novel.tasks).toEqual([]);

      const search = await invoke('status', 'novel_search', [{ title: '海边的信', author: '小鱼' }]) as { candidates: Array<NovelSearchCandidate & { match: string }> };
      expect(search.candidates).toHaveLength(1);
      expect(search.candidates[0]!.match).toBe('exact');

      const started = await invoke('status', 'novel_fetch', [search.candidates[0]]) as { id: string; state: string };
      expect(started.state).toBe('queued');
      let task: { state: string; bookKey?: string; error?: string } | undefined;
      for (let attempt = 0; attempt < 200; attempt++) {
        task = await invoke('status', 'novel_task', [started.id]) as typeof task;
        if (task?.state === 'complete' || task?.state === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(task?.state).toBe('complete');
      const after = await invoke('status', 'get', []) as { books: Array<{ title: string; author: string }>; novel: { tasks: Array<{ id: string; state: string }> } };
      expect(after.books).toHaveLength(1);
      expect(after.books[0]).toMatchObject({ title: '海边的信', author: '小鱼' });
      expect(after.novel.tasks[0]).toMatchObject({ id: started.id, state: 'complete' });
    } finally { await world.stop(); }
  });

  it('does not expose a fetch that fails its integrity gate', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bookfish-novel-world-')); dirs.push(dataDir);
    const taskDir = mkdtempSync(join(tmpdir(), 'bookfish-novel-task-')); dirs.push(taskDir);
    const engine = fakeEngine(taskDir);
    engine.download = async () => ({ taskDir, downloadDir: join(taskDir, 'downloads'), files: files().slice(0, 2), exitCode: 0, stderrTail: '' });
    const world = new BookfishWorld({ cfg: { ...BOOKFISH_DEFAULTS, allowNetwork: true }, timezone: 'UTC', dataDir, novelEngine: engine, novelPageProbe: null, novelWorkDir: join(dataDir, 'bookfish', 'novel-fetch') });
    await world.start(new FakeHost());
    try {
      const invoke = world.webUi!().invoke!;
      const started = await invoke('status', 'novel_fetch', [candidate]) as { id: string };
      let task: { state: string; issues: Array<{ code: string }> } | undefined;
      for (let attempt = 0; attempt < 200; attempt++) {
        task = await invoke('status', 'novel_task', [started.id]) as typeof task;
        if (task?.state === 'complete' || task?.state === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(task?.state).toBe('failed');
      expect(task?.issues.map((issue) => issue.code)).toContain('missing_chapter');
      const after = await invoke('status', 'get', []) as { books: unknown[] };
      expect(after.books).toHaveLength(0);
    } finally { await world.stop(); }
  });
});
