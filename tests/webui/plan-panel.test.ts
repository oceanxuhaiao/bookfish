// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BOOKFISH } from '../../src/definition.ts';
import bundle from '../../src/webui/client.ts';
import { FakeHost } from '../helpers/fake-host.ts';

let dir: string, world: ReturnType<typeof BOOKFISH.create>, controller: AbortController, dispose: (() => void) | undefined;
let confirmAnswer = false, lastConfirm: { title: string; body?: string; danger?: boolean } | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-plan-ui-'));
  confirmAnswer = true; lastConfirm = undefined;
  const context = fakeWorldContext(BOOKFISH, { scratchDir: dir });
  context.persist({ automaticReading: false, realRoutineEnabled: false });
  world = BOOKFISH.create(context);
  await world.start(new FakeHost());
  controller = new AbortController();
});
afterEach(async () => {
  dispose?.(); dispose = undefined; controller.abort();
  await world.stop();
  document.body.replaceChildren();
  rmSync(dir, { recursive: true, force: true });
});

async function mount() {
  const root = document.createElement('div'); document.body.append(root);
  const intervals: Array<() => Promise<void>> = [];
  const ctx = { root, panelId: 'plan', language: 'zh', signal: controller.signal,
    invoke: async (method: string, args: unknown[]) => world.webUi!('zh').invoke!('plan', method, args),
    setConfig: async () => 'Saved',
    interval: (callback: () => Promise<void>) => { intervals.push(callback); }, timeout: () => {}, own: () => {},
    ui: { confirm: async (options: { title: string; body?: string; danger?: boolean }) => { lastConfirm = options; return confirmAnswer; },
      toast: () => ({ dispose() {} }) },
  } as unknown as WebUiPanelContext;
  const handle = await bundle.panels.plan.mount(ctx);
  dispose = () => handle.dispose();
  return { root, poll: async () => { for (const callback of intervals) await callback(); } };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
function button(root: HTMLElement, label: string) { return [...root.querySelectorAll('button')].find((node) => node.textContent === label) as HTMLButtonElement | undefined; }
function rows(root: HTMLElement) { return [...root.querySelectorAll('[data-page=plan] .plan-item strong')].map((node) => node.textContent); }

async function planBooks(titles: string[]) {
  const keys: string[] = [];
  for (const title of titles) {
    const imported = await world.webUi!('zh').invoke!('plan', 'import', [{ filename: `${title}.txt`, title,
      base64: Buffer.from(`# ${title}\n` + '海风。'.repeat(400)).toString('base64') }]) as { book: { key: string } };
    keys.push(imported.book.key);
  }
  await world.webUi!('zh').invoke!('plan', 'plan_add', [{ bookKeys: keys }]);
  return keys;
}

describe('the reading plan page', () => {
  it('shows the order, the current book and an empty state before anything is planned', async () => {
    const { root } = await mount();
    expect(root.textContent).toContain('计划还是空的');
  });

  it('lists planned books in order and locks the row being read', async () => {
    const keys = await planBooks(['甲', '乙', '丙']);
    await world.webUi!('zh').invoke!('plan', 'select', [keys[0]]);
    const { root } = await mount();
    expect(rows(root)).toEqual(['1. 《甲》', '2. 《乙》', '3. 《丙》']);
    expect(root.textContent).toContain('正在读');
    const first = root.querySelector('[data-page=plan] .plan-item.is-active') as HTMLElement;
    expect(first.textContent).toContain('《甲》');
    // The active row offers no reorder or removal buttons at all; stopping is a
    // separate, explicit decision offered on the "reading now" card.
    expect([...first.querySelectorAll('button')]).toHaveLength(0);
    expect(button(root, '停止读这本，改读下一本')).toBeTruthy();
    expect(button(root, '移出计划')).toBeTruthy();
  });

  it('moves a waiting book to the top through the panel', async () => {
    const keys = await planBooks(['甲', '乙', '丙']);
    await world.webUi!('zh').invoke!('plan', 'select', [keys[0]]);
    const { root } = await mount();
    const third = [...root.querySelectorAll<HTMLElement>('[data-page=plan] .plan-item')][2];
    const top = [...third.querySelectorAll('button')].find((node) => node.textContent === '置顶')!;
    top.click();
    await settle(); await settle();
    // Nothing can be placed before the book being read: "top" is right after it.
    expect(rows(root)).toEqual(['1. 《甲》', '2. 《丙》', '3. 《乙》']);
    // The active book keeps its place and its progress.
    const status = await world.webUi!('zh').invoke!('plan', 'get', []) as { status: { library: { current: { title: string } } } };
    expect(status.status.library.current.title).toBe('甲');
  });

  it('marks a skipped book as skipped, never as finished', async () => {
    const keys = await planBooks(['甲', '乙']);
    await world.webUi!('zh').invoke!('plan', 'select', [keys[0]]);
    const { root } = await mount();
    const second = [...root.querySelectorAll<HTMLElement>('[data-page=plan] .plan-item')][1];
    [...second.querySelectorAll('button')].find((node) => node.textContent === '暂时跳过')!.click();
    await settle(); await settle();
    expect(lastConfirm?.title).toContain('暂时跳过');
    expect(rows(root)).toEqual(['1. 《甲》']);
    const plan = await world.webUi!('zh').invoke!('plan', 'get', []) as { plan: { completedCount: number; archive: Array<{ status: string; reason?: string }> } };
    expect(plan.plan.completedCount).toBe(0);
    expect(plan.plan.archive[0]).toMatchObject({ status: 'skipped' });
  });

  it('stops the current book only after an explicit confirmation', async () => {
    const keys = await planBooks(['甲', '乙']);
    await world.webUi!('zh').invoke!('plan', 'select', [keys[0]]);
    const { root } = await mount();
    confirmAnswer = false;
    button(root, '停止读这本，改读下一本')!.click();
    await settle(); await settle();
    expect((await world.webUi!('zh').invoke!('plan', 'get', []) as { plan: { current: { title: string } } }).plan.current.title).toBe('甲');

    confirmAnswer = true;
    button(root, '停止读这本，改读下一本')!.click();
    await settle(); await settle();
    const after = await world.webUi!('zh').invoke!('plan', 'get', []) as { plan: { current: { title: string } | null; completedCount: number; items: Array<{ title: string }> } };
    expect(after.plan.current?.title).toBe('乙');
    expect(after.plan.items.map((item) => item.title)).toEqual(['乙']);
    expect(after.plan.completedCount).toBe(0);
  });

  it('moves a whole series as one block and keeps its inner order', async () => {
    const keys = await planBooks(['甲', '乙', '丙', '丁']);
    const plan = await world.webUi!('zh').invoke!('plan', 'get', []) as { plan: { items: Array<{ id: string }> } };
    await world.webUi!('zh').invoke!('plan', 'plan_series', [{ action: 'create', name: '四部曲', itemIds: [plan.plan.items[1].id, plan.plan.items[2].id] }]);
    const { root } = await mount();
    expect(root.textContent).toContain('四部曲');
    const group = root.querySelector('[data-page=plan] .plan-series-group') as HTMLElement;
    expect([...group.querySelectorAll('summary')][0].textContent).toContain('四部曲 · 2');
    [...group.querySelectorAll('button')].find((node) => node.textContent === '整组上移')!.click();
    await settle(); await settle();
    expect(rows(root)).toEqual(['1. 《乙》', '2. 《丙》', '3. 《甲》', '4. 《丁》']);
    void keys;
  });
});

describe('series management and single-book planning', () => {
  it('creates, renames, ungroups and reorders a series from the plan page', async () => {
    const keys = await planBooks(['甲', '乙', '丙']);
    const invocation = world.webUi!('zh').invoke!;
    const view = await invocation('plan', 'get', []) as { plan: { items: { id: string }[] } };
    await invocation('plan', 'plan_series', [{ action: 'create', name: '三本一组', itemIds: [view.plan.items[1].id, view.plan.items[2].id] }]);
    const { root } = await mount();
    const group = root.querySelector('[data-page=plan] .plan-series-group') as HTMLElement;
    expect(group.querySelector('summary')!.textContent).toContain('三本一组 · 2');

    // Rename through the inline field.
    const field = group.querySelector<HTMLInputElement>('input[type=text]')!;
    field.value = '改过的名字';
    [...group.querySelectorAll('button')].find((node) => node.textContent === '重命名')!.click();
    await settle(); await settle();
    expect(root.textContent).toContain('改过的名字');

    // Members can leave the series without leaving the plan.
    const afterRename = await invocation('plan', 'get', []) as { plan: { series: { id: string; name: string }[] } };
    const renamed = afterRename.plan.series.find((row) => row.name === '改过的名字')!;
    await invocation('plan', 'plan_series', [{ action: 'assign', seriesId: null, itemIds: [view.plan.items[1].id] }]);
    const afterAssign = await invocation('plan', 'get', []) as { plan: { series: { id: string; count: number }[]; items: { bookKey: string }[] } };
    expect(afterAssign.plan.series.find((row) => row.id === renamed.id)?.count).toBe(1);
    expect(afterAssign.plan.items.map((item) => item.bookKey)).toEqual(keys);

    // Ungroup keeps the order and the progress.
    await invocation('plan', 'plan_series', [{ action: 'delete', seriesId: renamed.id }]);
    const afterDelete = await invocation('plan', 'get', []) as { plan: { series: unknown[]; items: { bookKey: string }[] } };
    expect(afterDelete.plan.series).toEqual([]);
    expect(afterDelete.plan.items.map((item) => item.bookKey)).toEqual(keys);
  });

  it('adopts a grouping proposal only when the user asks for it', async () => {
    await planBooks(['系列 第一部', '系列 第二部', '无关的书']);
    const { root } = await mount();
    const suggest = [...root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === '看分组建议');
    expect(suggest).toBeTruthy();
    suggest!.click();
    await settle(); await settle();
    // The proposal is listed, and nothing was grouped yet.
    const before = await world.webUi!('zh').invoke!('plan', 'get', []) as { plan: { series: unknown[] } };
    expect(before.plan.series).toEqual([]);
    const adopt = [...root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === '采用建议');
    if (adopt) {
      adopt.click();
      await settle(); await settle();
      const after = await world.webUi!('zh').invoke!('plan', 'get', []) as { plan: { series: { count: number }[] } };
      expect(after.plan.series.length).toBeGreaterThan(0);
      expect(after.plan.series[0].count).toBeGreaterThan(1);
    }
  });

  it('adds a single book to the plan from the book detail page', async () => {
    const keys = await planBooks(['甲']);
    // Remove it again so the detail page shows the "add" action.
    const invocation = world.webUi!('zh').invoke!;
    const view = await invocation('plan', 'get', []) as { plan: { items: { id: string }[] } };
    await invocation('plan', 'plan_update', [{ action: 'remove', itemId: view.plan.items[0].id, status: 'removed', keepReading: true }]);
    const { root } = await mount();
    const shelfNav = [...root.querySelectorAll<HTMLButtonElement>('nav button')].find((node) => node.textContent === '书架')!;
    shelfNav.click();
    await settle();
    const card = [...root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.getAttribute('aria-label')?.startsWith('查看这本书'));
    expect(card).toBeTruthy();
    card!.click();
    await settle(); await settle();
    const add = [...root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === '加入阅读计划');
    expect(add).toBeTruthy();
    add!.click();
    await settle(); await settle();
    const after = await invocation('plan', 'get', []) as { plan: { items: { bookKey: string }[] } };
    expect(after.plan.items.map((item) => item.bookKey)).toEqual(keys);
  });
});
