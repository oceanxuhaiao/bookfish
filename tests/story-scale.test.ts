import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BOOKFISH } from '../src/definition.ts';
import { Library } from '../src/library.ts';
import { FakeHost } from './helpers/fake-host.ts';

function longText(chapters: number) {
  let text = '';
  for (let i = 1; i <= chapters; i++) text += `第${i}章\n这是第${i}段连续叙事内容。\n`;
  return text;
}

describe('SSM scale isolation', () => {
  it('drives a 350+ segment isolated World through completion and story capture', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bookfish-story-scale-'));
    try {
      const ctx = fakeWorldContext(BOOKFISH, { scratchDir: dir });
      Object.assign(ctx.cfg, { automaticReading: false, realRoutineEnabled: false, readingBatchSegments: 1, storyMemoryEnabled: true });
      const world = BOOKFISH.create(ctx);
      const host = new FakeHost();
      await world.start(host);
      try {
        const invoke = world.webUi!('zh').invoke!;
        const imported = await invoke('status', 'import', [{ filename: 'scale.txt', title: '350段合成叙事', base64: Buffer.from(longText(360)).toString('base64') }]) as { book: { key: string } };
        await invoke('status', 'select', [imported.book.key]);
        const tool = async (name: string, args: Record<string, unknown>) => JSON.parse(await world.tools().find(t => t.name === name)!.handler(args, {} as ToolCallContext) as string);
        for (let i = 0; i < 360; i++) {
          const opportunity = await invoke('status', 'read_now', [imported.book.key]) as { opportunityId: string };
          const task = await tool('bookfish_read_next', { opportunityId: opportunity.opportunityId });
          await tool('bookfish_finish_reading', { taskId: task.taskId, bookKey: task.bookKey, segmentId: task.segmentId, understanding: '' });
        }
        const status = await invoke('status', 'get', []) as { status: { library: { current: { confirmedSegments: number }; story: { records: number } } } };
        expect(status.status.library.current.confirmedSegments).toBe(360);
        const captured = await tool('bookfish_review', {
          action: 'story', bookKey: imported.book.key, requestId: 'scale-1',
          storyChanges: [{ kind: 'event', summary: '第一段事件', evidenceSegmentIds: [0], quote: '这是第1段连续叙事内容。' }],
        });
        expect(captured.records).toHaveLength(1);
        expect((await invoke('status', 'get', []) as { status: { library: { story: { records: number } } } }).status.library.story.records).toBe(1);
      } finally {
        await world.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('pages a 2000+ segment book without reading the whole text into memory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bookfish-story-pages-'));
    try {
      const lib = new Library({ dataDir: dir, storyMemoryEnabled: true });
      lib.open();
      try {
        const imported = lib.importBytes({ filename: 'pages.txt', title: '2000段分页' }, Buffer.from(longText(2000))) as { book: { key: string } };
        const started = Date.now();
        let page = lib.reader({ bookKey: imported.book.key, segment: 0, chapterOffset: 0 });
        let pages = 1;
        while (page.nextChapterOffset !== null) {
          page = lib.reader({ bookKey: imported.book.key, segment: 0, chapterOffset: page.nextChapterOffset });
          pages++;
        }
        expect(pages).toBeGreaterThanOrEqual(20);
        expect(page.chapters.at(-1)?.title).toContain('第2000章');
        expect(Date.now() - started).toBeLessThan(10_000);
      } finally {
        lib.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
