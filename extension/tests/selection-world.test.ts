import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { BookfishWorld } from '../src/world.ts';
import { BOOKFISH_DEFAULTS } from '../src/config.ts';
import { assessNovelDownload, type CatalogChapter, type DownloadChapterFile } from '../src/novel-integrity.ts';
import type { NovelEngineLike } from '../src/novel-fetch.ts';
import type { NovelDownloadResult, NovelEngineAvailability } from '../src/novel-engine.ts';
import type { NovelSearchCandidate } from '../src/novel-match.ts';
import { FakeHost } from './helpers/fake-host.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const candidate: NovelSearchCandidate = { title: '海边的信', author: '小鱼', url: 'https://www.biquge365.net/book/77/',
  source: { id: 8, name: '笔趣阁365' }, revision: 'abcdef1234567890', latestChapter: '第3章', lastUpdateTime: '11-10' };
const catalog = (): CatalogChapter[] => [1, 2, 3].map((order) => ({ order, title: `第${order}章 海风`,
  url: `https://www.biquge365.net/chapter/77/${order}.html` }));
const files = (): DownloadChapterFile[] => catalog().map((chapter) => ({ order: chapter.order, title: chapter.title,
  text: `${chapter.title}\n\n　　${'海风吹过码头，小鱼取出一封信。'.repeat(8)}\n` }));
function engine(taskDir: string): NovelEngineLike {
  return { availability(): NovelEngineAvailability { return { available: true, engineDir: '/engine', version: '1.12.0', bridge: 'package' }; },
    async search() { return [candidate]; }, async toc() { return catalog(); },
    async download(): Promise<NovelDownloadResult> { return { taskDir, downloadDir: join(taskDir, 'downloads'), files: files(), exitCode: 0, stderrTail: '' }; },
    preflight(identity, list) { return assessNovelDownload({ book: identity, catalog: list, files: [], catalogOnly: true }); } };
}
describe('autonomous selection through actual World tools', () => {
  it('exposes controlled tools, queues the imported book key, and blocks the next search until it is read', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bookfish-selection-world-')); dirs.push(dataDir);
    const taskDir = mkdtempSync(join(tmpdir(), 'bookfish-selection-world-task-')); dirs.push(taskDir);
    const world = new BookfishWorld({ cfg: { ...BOOKFISH_DEFAULTS, allowNetwork: true, autonomousAcquisition: true,
      autonomousAcquisitionMode: 'auto', realRoutineEnabled: false }, timezone: 'UTC', dataDir,
      novelEngine: engine(taskDir), novelPageProbe: null, novelWorkDir: join(dataDir, 'novel-fetch') });
    const host = new FakeHost();
    await world.start(host);
    try {
      const tool = async (name: string, args: Record<string, unknown>) =>
        JSON.parse(await world.tools().find((entry) => entry.name === name)!.handler(args, {} as ToolCallContext) as string);
      const started = await tool('bookfish_acquire', { action: 'find', title: '海边的信', author: '小鱼', reason: '最近想读一个短篇。' });
      expect(started.allowed).toBe(true);
      // Wait on the durable result instead of a UI timer.
      let summary: { intent?: { id?: string; status?: string; bookKey?: string }; queue?: unknown[] } = {};
      for (let i = 0; i < 200; i++) {
        summary = await tool('bookfish_acquire', { action: 'status' });
        if (summary.intent?.bookKey) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(summary.intent?.status).toBe('reading');
      expect(summary.intent?.bookKey).toBeTruthy();
      expect(summary.queue).toHaveLength(1);
      const panel = await world.webUi!().invoke!('shelf', 'get', []) as { books: unknown[]; selection: { commitment: unknown } };
      expect(panel.books).toHaveLength(1);
      expect(panel.selection.commitment).toBeTruthy();
      const blocked = await tool('bookfish_acquire', { action: 'find', title: '另一本', author: '小鱼', reason: '再找一本' });
      expect(blocked.allowed).toBe(false);
      expect(blocked.gate.code).toBe('self_selected_unfinished');
      expect(host.events.some((event) => event.type === 'bookfish.acquisition_changed')).toBe(true);
      const plan = await tool('bookfish_acquire', { action: 'plan', intentId: summary.intent?.id, planAction: 'queue' });
      expect(plan.queue).toHaveLength(1);
    } finally { await world.stop(); }
  });
});
