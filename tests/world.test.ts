import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext, WorldHost } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BOOKFISH } from '../src/definition.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { Library } from '../src/library.ts';
let scratchDir: string;
beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'bookfish-world-')); });
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));
function create() { const ctx = fakeWorldContext(BOOKFISH, { scratchDir }); ctx.persist({automaticReading:false,realRoutineEnabled:false,readingBatchSegments:1}); return { ctx, world: BOOKFISH.create(ctx) }; }
async function status(world: ReturnType<typeof create>['world']) {
  const result = await world.tools()[0].handler({}, {} as ToolCallContext);
  return JSON.parse(typeof result === 'string' ? result : result.text);
}
describe('Bookfish library World', () => {
  it('retains the latest writer fence when TXT shutdown fails and permits a clean retry', async () => {
    const { ctx, world } = create();
    await world.start(new FakeHost());
    const acquisition = (world as unknown as { txtAcquisition: { stop(): Promise<void> } }).txtAcquisition;
    const stop = vi.spyOn(acquisition, 'stop').mockRejectedValueOnce(new Error('injected TXT stop failure'));
    const competitor = new Library({ dataDir: ctx.dataDir });
    try {
      await expect(world.stop()).rejects.toThrow(/书库写锁仍保留/);
      expect(() => competitor.open()).toThrow();
      await world.stop();
      competitor.open();
      competitor.close();
      await world.start(new FakeHost());
      const panel = await world.webUi!().invoke!('status', 'get', []) as { status: { txtAcquisition: unknown } };
      expect(panel.status.txtAcquisition).toMatchObject({ controllerReady: false, browserReady: false });
    } finally {
      stop.mockRestore();
      await world.stop();
    }
  });
  it('drives two paced opportunities through actual World hooks, timer, panel and tool handlers', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-07T02:00:00Z'));
    const { ctx, world } = create(); ctx.persist({ automaticReading: true, readingMode: 'main' });
    const queued: Parameters<WorldHost['pushDeferred']>[0][] = [];
    const host = new FakeHost(); host.pushDeferred = (event) => { queued.push(event); };
    try {
      await world.start(host); const invoke = world.webUi!().invoke!;
      const imported = await invoke('status', 'import', [{ filename: 'long.txt', title: '合成小说', base64: Buffer.from('鱼读海边故事。'.repeat(700)).toString('base64') }]) as { book: { key: string } };
      await invoke('status', 'select', [imported.book.key]);
      world.onRunPhase!({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
      const tool = async (name: string, args: Record<string, unknown>) => JSON.parse(await world.tools().find(t => t.name === name)!.handler(args, {} as ToolCallContext) as string);
      for (let i = 0; i < 2; i++) {
        await vi.advanceTimersByTimeAsync(600000);
        const event = queued[i]; expect(event.type).toBe('bookfish.reading_opportunity'); expect(await event.render()).not.toBeNull();
        const opportunityId = event.meta!.opportunityId;
        world.onEventsSettled!([{ ...event, cursor: i + 1, ts: '', source: 'bookfish', origin: 'internal', text: 'protocol test' }], 'delivered');
        world.onRunPhase!({ state: 'tools', running: ['bookfish_read_next'], enteredAt: new Date().toISOString() });
        const task = await tool('bookfish_read_next', { opportunityId });
        await tool('bookfish_finish_reading', { taskId: task.taskId, bookKey: task.bookKey, segmentId: task.segmentId, understanding: '合成协议测试，不代表真实模型。' });
        world.onTurnEnded!(); world.onRunPhase!({ state: 'idle', running: [], enteredAt: new Date().toISOString() });
        expect((await status(world)).library.current.confirmedSegments).toBe(i + 1);
      }
      expect((await status(world)).scheduler.budget).toMatchObject({ tasks: 2, chars: 2400 });
    } finally { await world.stop(); vi.useRealTimers(); }
  });
  it('passes the official dry mount', async () => {
    expect((await dryMountWorld(BOOKFISH, { scratchDir })).failures).toEqual([]);
  });
  it('reports stopped before mount and after stop; mounting does not enable automatic reading', async () => {
    const { world } = create();
    expect(await status(world)).toMatchObject({ lifecycle: 'stopped', cognition: 'not-mounted', selectedMode: 'unavailable' });
    expect(world.webUi!('zh').lamps?.[0]).toMatchObject({ label: '阅读', state: 'offline' });
    const host = new FakeHost();
    await world.start(host);
    expect(await status(world)).toMatchObject({ lifecycle: 'running', cognition: 'unavailable', selectedMode: 'main', readingAvailable: true, automaticReadingAvailable: true, output: 'persona-mediated' });
    expect(world.webUi!('zh').lamps?.[0]).toMatchObject({ label: '阅读', state: 'online' });
    expect(host.events[0].type).toBe('bookfish.started');
    expect(host.pushOpts[0]?.trigger).toBe('piggyback');
    await world.stop();
    expect(await status(world)).toMatchObject({ lifecycle: 'stopped', cognition: 'not-mounted' });
    expect(world.webUi!('zh').lamps?.[0]).toMatchObject({ state: 'offline' });
  });
  it('reads current cognition availability and hot configuration without requesting a model', async () => {
    const { ctx, world } = create();
    let calls = 0;
    let cognition: WorldHost['cognition'] = { request: async () => { calls++; return { text: 'unused' }; } };
    const host = new FakeHost();
    Object.defineProperty(host, 'cognition', { get: () => cognition });
    await world.start(host);
    expect((await status(world)).selectedMode).toBe('background');
    ctx.persist({ readingMode: 'main' });
    expect((await status(world)).selectedMode).toBe('main');
    ctx.persist({ readingMode: 'auto' });
    cognition = undefined;
    expect((await status(world)).selectedMode).toBe('main');
    expect(calls).toBe(0);
    await world.stop();
  });
  it('mounts and closes the optional story sidecar without enabling it by default', async () => {
    const ctx = fakeWorldContext(BOOKFISH, { scratchDir });
    Object.assign(ctx.cfg, { automaticReading: false, realRoutineEnabled: false, readingBatchSegments: 1, storyMemoryEnabled: true });
    const world = BOOKFISH.create(ctx);
    await world.start(new FakeHost());
    const panel = await world.webUi!('zh').invoke!('status', 'get', []) as { status: { library: { story: { enabled: boolean; records?: number } } } };
    expect(panel.status.library.story).toMatchObject({ enabled: true });
    await world.stop();
  });
  it('captures a story fact through the optional tool without advancing reading', async () => {
    const ctx = fakeWorldContext(BOOKFISH, { scratchDir });
    Object.assign(ctx.cfg, { automaticReading: false, realRoutineEnabled: false, readingBatchSegments: 1, storyMemoryEnabled: true });
    const world = BOOKFISH.create(ctx);
    const host = new FakeHost();
    await world.start(host);
    try {
      const invoke = world.webUi!('zh').invoke!;
      const imported = await invoke('status', 'import', [{ filename: 's.txt', title: '故事工具', base64: Buffer.from('第一章\n鱼读海边故事。\n' + '海风。'.repeat(200)).toString('base64') }]) as { book: { key: string } };
      await invoke('status', 'select', [imported.book.key]);
      const opportunity = await invoke('status', 'read_now', [imported.book.key]) as { opportunityId: string };
      const tool = async (name: string, args: Record<string, unknown>) => JSON.parse(await world.tools().find(t => t.name === name)!.handler(args, {} as ToolCallContext) as string);
      const task = await tool('bookfish_read_next', { opportunityId: opportunity.opportunityId });
      await tool('bookfish_finish_reading', { taskId: task.taskId, bookKey: task.bookKey, segmentId: task.segmentId, understanding: '' });
      const before = (await status(world)).library.current.confirmedSegments;
      const captured = await tool('bookfish_review', {
        action: 'story', bookKey: imported.book.key, requestId: 'tool-story-1',
        storyChanges: [{ kind: 'event', summary: '鱼在海边读故事', names: ['鱼'], evidenceSegmentIds: [0], quote: '鱼读海边故事。' }],
      });
      expect(captured.records).toHaveLength(1);
      expect((await status(world)).library.current.confirmedSegments).toBe(before);
      const overview = await tool('bookfish_lookup', { action: 'story', storyAction: 'overview', bookKey: imported.book.key, atFrontier: 1 });
      expect(overview.packs).toEqual([]);
      const evidence = await tool('bookfish_lookup', { action: 'story', storyAction: 'evidence', bookKey: imported.book.key, eventIds: [captured.records[0].id], atFrontier: 1 });
      expect(evidence.events[0]).toMatchObject({ summary: '鱼在海边读故事' });
      const entity = await tool('bookfish_lookup', { action: 'story', storyAction: 'entity', bookKey: imported.book.key, query: '鱼' });
      expect(entity.status).toBe('resolved');
      const duplicate = await tool('bookfish_review', {
        action: 'story', bookKey: imported.book.key, requestId: 'tool-story-1',
        storyChanges: [{ kind: 'event', summary: '鱼在海边读故事', names: ['鱼'], evidenceSegmentIds: [0], quote: '鱼读海边故事。' }],
      });
      expect(duplicate.duplicate).toBe(true);
      expect((await status(world)).library.current.confirmedSegments).toBe(before);
    } finally {
      await world.stop();
    }
  });
  it('keeps the model-facing status compact while the panel keeps the full shape', async () => {
    const { world } = create();
    await world.start(new FakeHost());
    const panel = world.webUi!('zh');
    const invoke = panel.invoke!;
    const imported = await invoke('status', 'import', [{ filename: 's.txt', title: '状态样本', base64: Buffer.from('海边有鱼。'.repeat(20)).toString('base64') }]) as { book: { key: string } };
    await invoke('status', 'select', [imported.book.key]);
    const panelStatus = (await invoke('status', 'get', []) as { status: Record<string, unknown> }).status;
    const toolStatus = await status(world);
    const { sharing: panelSharing, ...panelCore } = panelStatus;
    const { sharing: toolSharing, ...toolCore } = toolStatus;
    // Decision-relevant fields still match; capability dumps stay panel-only.
    for (const key of ['lifecycle', 'readingAvailable', 'automaticReadingAvailable', 'selectedMode', 'cognition', 'output', 'networkEnabled']) {
      expect(toolCore[key]).toEqual(panelCore[key]);
    }
    expect((toolCore.library as Record<string, unknown>).current).toEqual(expect.objectContaining({ key: (panelCore.library as Record<string, any>).current.key }));
    expect((toolCore.library as Record<string, unknown>).current).not.toHaveProperty('serial');
    expect((panelCore.library as Record<string, unknown>).current).toHaveProperty('serial');
    expect(toolCore).not.toHaveProperty('selection');
    expect(panelCore).toHaveProperty('selection');
    expect(panelSharing).toHaveProperty('items');
    expect(toolSharing).not.toHaveProperty('items');
    expect(JSON.stringify(toolCore).length).toBeLessThan(JSON.stringify(panelCore).length);
    await expect(invoke('status', 'unknown', [])).rejects.toThrow();
    await expect(invoke('other', 'get', [])).rejects.toThrow();
    await world.stop();
  });
  it('rolls back state when event persistence fails, allowing a clean subsequent mount', async () => {
    const { world } = create();
    const host = new FakeHost();
    host.pushEvent = async () => { throw new Error('storage unavailable'); };
    await expect(world.start(host)).rejects.toThrow('storage unavailable');
    expect((await status(world)).lifecycle).toBe('stopped');
    await world.start(new FakeHost());
    expect((await status(world)).lifecycle).toBe('running');
    await world.stop();
  });
  it('rejects an aborted confirmation and serializes concurrent retries into one confirmed range', async () => {
    const { world } = create(); await world.start(new FakeHost());
    try {
      const panel = world.webUi!().invoke!;
      const imported = await panel('status', 'import', [{ filename: 'x.txt', title: '样本', base64: Buffer.from('海边的小鱼').toString('base64') }]) as { book: { key: string } };
      await panel('status', 'select', [imported.book.key]);
      const read = world.tools().find(t => t.name === 'bookfish_read_next')!;
      const finish = world.tools().find(t => t.name === 'bookfish_finish_reading')!;
      expect(read.barrierAfter).toBe(true);
      const task = JSON.parse(await read.handler({}, {} as ToolCallContext) as string);
      const args = { taskId: task.taskId, bookKey: task.bookKey, segmentId: task.segmentId, understanding: '小鱼在海边。' };
      const abort = new AbortController(); abort.abort();
      await expect(finish.handler(args, { signal: abort.signal } as ToolCallContext)).rejects.toThrow(/cancelled/);
      expect((await status(world)).library.current.confirmedChars).toBe(0);
      const results = await Promise.all([finish.handler(args, {} as ToolCallContext), finish.handler(args, {} as ToolCallContext)]);
      expect(results.map(r => JSON.parse(r as string).duplicate)).toEqual([false, true]);
      expect((await status(world)).library.current.confirmedSegments).toBe(1);
    } finally { await world.stop(); }
  });
  it('exposes the declared reading start to the panel only, and rejects an invalid start', async () => {
    const { world } = create(); await world.start(new FakeHost());
    try {
      const invoke = world.webUi!().invoke!;
      const body = '风吹过海面。\n'.repeat(1800);
      const imported = await invoke('status', 'import', [{ filename: 'start.md', title: '起点样本', base64: Buffer.from(`# 第一章 海边\n${body}\n# 第二章 回家\n${body}`).toString('base64') }]) as { book: { key: string } };
      const key = imported.book.key;
      await invoke('status', 'select', [key]);
      const listed = await invoke('status', 'chapters', [key]) as { total: number; truncated: boolean; items: Array<{ title: string; segment: number }> };
      expect(listed.total).toBeGreaterThanOrEqual(2);
      expect(listed.truncated).toBe(false);
      expect(listed.items[0]!.title).toContain('第一章');
      const second = listed.items[1]!;
      // Panel-only: no model tool may exist for either control.
      expect(world.tools().map(tool => tool.name)).not.toContain('bookfish_set_start');
      expect(world.tools().map(tool => tool.name)).not.toContain('bookfish_chapters');
      await expect(invoke('status', 'set_start', [{ bookKey: key, segment: 'nope' }])).rejects.toThrow(/out of range/);
      await expect(invoke('status', 'set_start', [{ bookKey: key, segment: second.segment + 1 }])).rejects.toThrow(/first segment of a chapter/);
      const panelCurrent = async () => ((await invoke('status', 'get', [])) as { status: { library: { current: Record<string, unknown> } } }).status.library.current;
      expect((await panelCurrent()).priorReadingSegments).toBe(0);
      const view = await invoke('status', 'set_start', [{ bookKey: key, segment: second.segment }]) as { priorReadingSegments: number; confirmedSegments: number };
      expect(view.priorReadingSegments).toBe(second.segment);
      expect(view.confirmedSegments).toBe(0);
      const current = await panelCurrent();
      expect(current.priorReadingSegments).toBe(second.segment);
      expect(current.chapter).toContain('第二章');
      expect(current.confirmedChars).toBe(0);
      // A declared start locks once reading begins.
      const task = JSON.parse(await world.tools().find(tool => tool.name === 'bookfish_read_next')!.handler({}, {} as ToolCallContext) as string);
      await world.tools().find(tool => tool.name === 'bookfish_finish_reading')!.handler({ taskId: task.taskId, bookKey: task.bookKey, segmentId: task.segmentId, understanding: '' }, {} as ToolCallContext);
      await expect(invoke('status', 'set_start', [{ bookKey: key, segment: 0 }])).rejects.toThrow(/locked/);
    } finally { await world.stop(); }
  });
});
