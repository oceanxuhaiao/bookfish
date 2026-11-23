// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BOOKFISH } from '../../src/definition.ts';
import type { BookfishConfigSection } from '../../src/config.ts';
import bundle from '../../src/webui/client.ts';
import { FakeHost } from '../helpers/fake-host.ts';

let dir: string;
let persist: (values: Partial<BookfishConfigSection>) => void;
let world: ReturnType<typeof BOOKFISH.create>;
let controller: AbortController;
let dispose: (() => void) | undefined;
let store: Map<string, unknown>;
let failNew = false;
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-fp-'));
  store = new Map();
  failNew = false;
  const context = fakeWorldContext(BOOKFISH, { scratchDir: dir });
  persist = context.persist;
  persist({ automaticReading: false, realRoutineEnabled: false });
  world = BOOKFISH.create(context);
  await world.start(new FakeHost());
  controller = new AbortController();
});
afterEach(async () => {
  vi.restoreAllMocks();
  dispose?.(); dispose = undefined;
  controller.abort();
  await world.stop();
  document.body.replaceChildren();
  rmSync(dir, { recursive: true, force: true });
});

async function tool(name: string, args: Record<string, unknown>) {
  return JSON.parse(await world.tools().find((item) => item.name === name)!.handler(args, {} as ToolCallContext) as string);
}
const invoke = (method: string, args: unknown[]) => world.webUi!('zh').invoke!('trail', method, args) as Promise<any>;

async function seed(title: string, count: number) {
  const book = await world.webUi!('zh').invoke!('trail', 'import', [{ filename: `${title}.txt`, title,
    base64: Buffer.from(`序章：${title}的海风轻轻吹过岸边，她把信放进抽屉。` + '远处传来潮声。'.repeat(400)).toString('base64') }]) as any;
  await world.webUi!('zh').invoke!('trail', 'select', [book.book.key]);
  const task = await tool('bookfish_read_next', {});
  await tool('bookfish_finish_reading', { ...task, understanding: `${title} 读到海边。`,
    episode: { trigger: '海风吹过', interpretation: `${title} 第一次感想`, evidence: [{ segmentId: task.segmentId, quote: '海风轻轻吹过岸边' }] } });
  const slug = [...title].map((character) => character.codePointAt(0)!.toString(16)).join('-');
  for (let index = 1; index < count; index++) {
    await tool('bookfish_record_reflection', { bookKey: book.book.key, requestId: `${slug}-${index}`,
      episode: { trigger: '抽屉里的信', interpretation: `${title} 第 ${index} 次回想`, evidence: [{ segmentId: 0, quote: '她把信放进抽屉' }] } });
  }
  return book.book.key as string;
}

async function mount(panelId = 'trail') {
  const root = document.createElement('div'); document.body.append(root);
  const intervals: Array<() => void> = [];
  const memo = {
    get<T>(key: string, fallback: T): T { return store.has(key) ? store.get(key) as T : fallback; },
    set(key: string, value: unknown) { store.set(key, value); },
  };
  const ctx = {
    root, panelId, language: 'zh', signal: controller.signal, memo,
    invoke: async (method: string, args: unknown[]) => {
      if (failNew && method === 'journal_new') throw new Error('preview failed');
      return world.webUi!('zh').invoke!(panelId, method, args);
    },
    setConfig: async (_group: string, values: Record<string, unknown>) => { persist(Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace('worlds.bookfish.', ''), value]))); return 'Saved'; },
    interval: (callback: () => void) => { intervals.push(callback); return { dispose() {} }; },
    timeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    own: <T,>(d: T) => d,
    ui: { confirm: async () => false, toast: () => ({ dispose() {} }) },
  } as unknown as WebUiPanelContext;
  const panel = (bundle.panels as Record<string, typeof bundle.panels.status>)[panelId] ?? bundle.panels.status;
  const handle = await panel.mount(ctx); dispose = () => handle.dispose();
  return { root, poll: async () => { for (const callback of intervals) callback(); await settle(); } };
}
function action(root: HTMLElement, label: string) {
  return [...root.querySelectorAll('button')].find((button) => button.textContent === label) as HTMLButtonElement;
}
function cards(root: HTMLElement) { return [...root.querySelectorAll<HTMLElement>('.bf-fp-list .bf-fp-card')]; }
async function sendDiscussion(root: HTMLElement) {
  const box = root.querySelector<HTMLTextAreaElement>('[aria-label="你想和她聊什么？"]')!;
  box.value = '这段怎么理解？';
  const send = [...root.querySelectorAll('button')].find((button) => button.textContent === '发送给大肥鱼') as HTMLButtonElement;
  // Opening the chat runs through perform(); wait for that pass to finish before sending.
  await new Promise((resolve) => setTimeout(resolve, 600));
  send.click();
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 300));
}
function metatexts(root: HTMLElement) { return cards(root).map((card) => card.querySelector('.bf-fp-thought')!.textContent); }
function pagerText(root: HTMLElement) { return root.querySelector('.bf-fp-pager span')!.textContent ?? ''; }
function bookSelect(root: HTMLElement) { return root.querySelector<HTMLSelectElement>('select[aria-label="筛选书籍"]')!; }

describe('reading footprint browser', () => {
  it('opens on all books, newest first, ten per page', async () => {
    await seed('甲书', 4); await seed('乙书', 4); await seed('丙书', 4);
    const { root } = await mount();
    await vi.waitFor(() => expect(cards(root).length).toBe(10));
    expect(bookSelect(root).value).toBe('');
    expect(root.querySelector<HTMLSelectElement>('select[aria-label="足迹排序"]')!.value).toBe('desc');
    expect(root.querySelector<HTMLSelectElement>('select[aria-label="每页数量"]')!.value).toBe('10');
    const side = root.querySelector<HTMLElement>('.bf-fp-toolbar-side')!;
    expect(side.contains(root.querySelector('select[aria-label="足迹排序"]'))).toBe(true);
    expect(side.contains(root.querySelector('select[aria-label="每页数量"]'))).toBe(true);
    expect(root.querySelector('.bf-fp-toolbar')!.lastElementChild).toBe(side);
    expect(metatexts(root)[0]).toContain('丙书 第 3 次回想');
    expect(pagerText(root)).toContain('第 1 / 2 页');
    expect(pagerText(root)).toContain('共 12 条');
    expect(action(root, '上一页').disabled).toBe(true);
    expect(action(root, '下一页').disabled).toBe(false);
  });

  it('searches books by title, keeps an explicit book and preserves order and page size', async () => {
    await seed('甲书', 4); await seed('乙书', 4); await seed('丙书', 4);
    const { root } = await mount();
    await vi.waitFor(() => expect(cards(root).length).toBe(10));
    const order = root.querySelector<HTMLSelectElement>('select[aria-label="足迹排序"]')!;
    const size = root.querySelector<HTMLSelectElement>('select[aria-label="每页数量"]')!;
    order.value = 'asc'; order.dispatchEvent(new Event('change', { bubbles: true }));
    size.value = '5'; size.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    const search = root.querySelector<HTMLInputElement>('input[aria-label="搜索书籍"]')!;
    search.value = '甲'; search.dispatchEvent(new Event('input', { bubbles: true }));
    expect([...bookSelect(root).options].map((option) => option.textContent)).toEqual(['全部书籍（12）', expect.stringContaining('甲书')]);
    search.value = '不存在的书名'; search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('.bf-fp-message')!.textContent).toContain('没有匹配的书籍');
    search.value = '甲'; search.dispatchEvent(new Event('input', { bubbles: true }));
    const target = [...bookSelect(root).options].find((option) => (option.textContent ?? '').includes('甲书'))!;
    bookSelect(root).value = target.value; bookSelect(root).dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(pagerText(root)).toContain('共 4 条'));
    expect(metatexts(root).every((text) => text?.includes('甲书'))).toBe(true);
    expect(order.value).toBe('asc');
    expect(size.value).toBe('5');
    expect(cards(root)).toHaveLength(4);
  });

  it('walks pages in both directions and returns to the latest record', async () => {
    await seed('甲书', 4); await seed('乙书', 4); await seed('丙书', 4);
    const { root } = await mount();
    await vi.waitFor(() => expect(cards(root).length).toBe(10));
    const firstPage = metatexts(root);
    expect(cards(root)).toHaveLength(10);
    action(root, '下一页').click(); await settle();
    await vi.waitFor(() => expect(pagerText(root)).toContain('第 2 / 2 页'));
    expect(cards(root)).toHaveLength(2);
    const secondPage = metatexts(root);
    expect(secondPage.some((text) => firstPage.includes(text))).toBe(false);
    action(root, '上一页').click(); await settle();
    await vi.waitFor(() => expect(metatexts(root)).toEqual(firstPage));
    action(root, '下一页').click(); await settle();
    await vi.waitFor(() => expect(pagerText(root)).toContain('第 2 / 2 页'));
    action(root, '回到最新').click(); await settle();
    await vi.waitFor(() => expect(pagerText(root)).toContain('第 1 / 2 页'));
    expect(metatexts(root)).toEqual(firstPage);
  });

  it('starts at the earliest record when oldest-first is selected', async () => {
    await seed('甲书', 4); await seed('乙书', 4); await seed('丙书', 4);
    const { root } = await mount();
    await vi.waitFor(() => expect(cards(root).length).toBe(10));
    expect(pagerText(root)).toContain('第 1 / 2 页');
    expect(metatexts(root)[0]).toContain('丙书 第 3 次回想');
    const order = root.querySelector<HTMLSelectElement>('select[aria-label="足迹排序"]')!;
    order.value = 'asc'; order.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(order.value).toBe('asc'));
    await vi.waitFor(() => expect(metatexts(root)[0]).toContain('甲书 第一次感想'));
    expect(pagerText(root)).toContain('第 1 / 2 页');
    order.value = 'desc'; order.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(metatexts(root)[0]).toContain('丙书 第 3 次回想'));
    expect(pagerText(root)).toContain('第 1 / 2 页');
  });

  it('returns to the real last page when oldest-first is selected', async () => {
    await seed('甲书', 4); await seed('乙书', 4); await seed('丙书', 4);
    const { root } = await mount();
    await vi.waitFor(() => expect(cards(root).length).toBe(10));
    const order = root.querySelector<HTMLSelectElement>('select[aria-label="足迹排序"]')!;
    order.value = 'asc'; order.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(pagerText(root)).toContain('第 1 / 2 页'));
    expect(cards(root)).toHaveLength(10);
    action(root, '回到最新').click(); await settle();
    await vi.waitFor(() => expect(pagerText(root)).toContain('第 2 / 2 页'));
    expect(cards(root)).toHaveLength(2);
    expect(root.querySelector('.bf-fp-list')!.textContent).toContain('丙书 第 3 次回想');
    action(root, '上一页').click(); await settle();
    await vi.waitFor(() => expect(pagerText(root)).toContain('第 1 / 2 页'));
    expect(cards(root)).toHaveLength(10);
  });

  it('restores filter, order, page size, page anchor and scroll position after remount', async () => {
    await seed('甲书', 4); await seed('乙书', 6); await seed('丙书', 4);
    const first = await mount();
    await vi.waitFor(() => expect(cards(first.root).length).toBe(10));
    const order = first.root.querySelector<HTMLSelectElement>('select[aria-label="足迹排序"]')!;
    const size = first.root.querySelector<HTMLSelectElement>('select[aria-label="每页数量"]')!;
    order.value = 'asc'; order.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(pagerText(first.root)).toContain('第 1 / 2 页'));
    await vi.waitFor(() => expect(metatexts(first.root)[0]).toContain('甲书 第一次感想'));
    size.value = '5'; size.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    // Switching order starts at page 1; changing the page size keeps the current (oldest) record.
    await vi.waitFor(() => expect(pagerText(first.root)).toContain('第 1 / 3 页'));
    action(first.root, '下一页').click(); await settle();
    await vi.waitFor(() => expect(pagerText(first.root)).toContain('第 2 / 3 页'));
    const anchorPage = metatexts(first.root);
    const list = first.root.querySelector<HTMLElement>('.bf-fp-list')!;
    list.scrollTop = 40; list.dispatchEvent(new Event('scroll')); await settle();
    expect(list.scrollTop).toBe(40);
    dispose!(); dispose = undefined;
    expect((store.get('browse-v1') as { scrollTop: number }).scrollTop).toBe(40);
    const second = await mount();
    await vi.waitFor(() => expect(metatexts(second.root)).toEqual(anchorPage));
    expect((store.get('browse-v1') as { scrollTop: number }).scrollTop).toBe(40);
    expect(second.root.querySelector<HTMLSelectElement>('select[aria-label="足迹排序"]')!.value).toBe('asc');
    expect(second.root.querySelector<HTMLSelectElement>('select[aria-label="每页数量"]')!.value).toBe('5');
    expect(pagerText(second.root)).toContain('第 2 / 3 页');
    expect(second.root.querySelector<HTMLElement>('.bf-fp-list')!.scrollTop).toBe(40);
  });

  it('falls back to defaults when the stored browse state is corrupt', async () => {
    await seed('甲书', 4);
    store.set('browse-v1', { v: 1, scope: 7, order: 'sideways', limit: 7, anchor: 'x', scrollTop: -5, lastPresented: 'nope' });
    const first = await mount();
    await vi.waitFor(() => expect(cards(first.root).length).toBe(4));
    expect(bookSelect(first.root).value).toBe('');
    expect(first.root.querySelector<HTMLSelectElement>('select[aria-label="足迹排序"]')!.value).toBe('desc');
    expect(first.root.querySelector<HTMLSelectElement>('select[aria-label="每页数量"]')!.value).toBe('10');
    dispose!(); dispose = undefined;
    store.set('browse-v1', 'not-an-object');
    const second = await mount();
    await vi.waitFor(() => expect(cards(second.root).length).toBe(4));
    expect(pagerText(second.root)).toContain('共 4 条');
  });

  it('announces new footprints, previews them without moving the history page, and collapses cleanly', async () => {
    const first = await seed('甲书', 6); await seed('乙书', 4);
    const { root, poll } = await mount();
    await vi.waitFor(() => expect(cards(root).length).toBe(10));
    // The first activation establishes the baseline: existing history is never reported as new.
    await poll();
    expect(root.querySelector<HTMLElement>('.bf-fp-banner')!.hidden).toBe(true);
    const firstPage = metatexts(root);
    const firstPager = pagerText(root);
    await tool('bookfish_record_reflection', { bookKey: first, requestId: 'new-one',
      episode: { trigger: '新的潮声', interpretation: '新的一条足迹', evidence: [{ segmentId: 0, quote: '海风轻轻吹过岸边' }] } });
    await poll();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.bf-fp-banner')!.hidden).toBe(false));
    expect(root.querySelector('.bf-fp-banner')!.textContent).toContain('大肥鱼新增了 1 条足迹');
    expect(metatexts(root)).toEqual(firstPage);
    action(root, '查看新增').click();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.bf-fp-preview')!.hidden).toBe(false));
    expect([...root.querySelectorAll('.bf-fp-preview-list .bf-fp-card')]).toHaveLength(1);
    expect(metatexts(root)).toEqual(firstPage);
    expect(pagerText(root)).toBe(firstPager);
    action(root, '整体收起').click(); await settle();
    expect(root.querySelector<HTMLElement>('.bf-fp-preview')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('.bf-fp-banner')!.hidden).toBe(true);
    await poll();
    expect(root.querySelector<HTMLElement>('.bf-fp-banner')!.hidden).toBe(true);
    expect(metatexts(root)).toEqual(firstPage);
  });

  it('keeps the reminder when the preview query fails and only advances after a successful collapse', async () => {
    const first = await seed('甲书', 4);
    const { root, poll } = await mount();
    await vi.waitFor(() => expect(cards(root).length).toBe(4));
    await poll();
    await tool('bookfish_record_reflection', { bookKey: first, requestId: 'new-failure',
      episode: { trigger: '新的潮声', interpretation: '失败样本', evidence: [{ segmentId: 0, quote: '海风轻轻吹过岸边' }] } });
    await poll();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.bf-fp-banner')!.hidden).toBe(false));
    failNew = true;
    action(root, '查看新增').click(); await settle();
    expect(root.querySelector<HTMLElement>('.bf-fp-preview')!.hidden).toBe(true);
    expect(root.querySelector('.bf-fp-message')!.textContent).toContain('preview failed');
    await poll();
    expect(root.querySelector<HTMLElement>('.bf-fp-banner')!.hidden).toBe(false);
    failNew = false;
    action(root, '查看新增').click();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.bf-fp-preview')!.hidden).toBe(false));
    action(root, '整体收起').click(); await settle();
    await poll();
    expect(root.querySelector<HTMLElement>('.bf-fp-banner')!.hidden).toBe(true);
  });

  it('scopes the reminder to the current book and keeps other books pending until all books are shown', async () => {
    const first = await seed('甲书', 3); const second = await seed('乙书', 3);
    const { root, poll } = await mount();
    await vi.waitFor(() => expect(cards(root).length).toBe(6));
    await poll();
    // Switch to 甲书; its own baseline is established on first view, so no false positive.
    const option = [...bookSelect(root).options].find((item) => (item.textContent ?? '').includes('甲书'))!;
    bookSelect(root).value = option.value; bookSelect(root).dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(pagerText(root)).toContain('共 3 条'));
    await poll();
    expect(root.querySelector<HTMLElement>('.bf-fp-banner')!.hidden).toBe(true);
    await tool('bookfish_record_reflection', { bookKey: second, requestId: 'other-book',
      episode: { trigger: '另一本书的潮声', interpretation: '乙书新增', evidence: [{ segmentId: 0, quote: '海风轻轻吹过岸边' }] } });
    await poll();
    expect(root.querySelector<HTMLElement>('.bf-fp-banner')!.hidden).toBe(true);
    bookSelect(root).value = ''; bookSelect(root).dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.bf-fp-banner')!.hidden).toBe(false));
    expect(root.querySelector('.bf-fp-banner')!.textContent).toContain('1 条足迹');
    action(root, '查看新增').click();
    await vi.waitFor(() => expect([...root.querySelectorAll('.bf-fp-preview-list .bf-fp-card')]).toHaveLength(1));
    expect(root.querySelector('.bf-fp-preview-list')!.textContent).toContain('乙书新增');
    expect(first).not.toBe(second);
  });

  it('discusses a footprint under its own book without changing the browse position', async () => {
    const firstBook = await seed('甲书', 3); const secondBook = await seed('乙书', 3);
    await invoke('select', [firstBook]);
    const { root } = await mount();
    await vi.waitFor(() => expect(cards(root).length).toBe(6));
    const state = await invoke('get', []) as any;
    expect(state.status.library.current.key).toBe(firstBook);
    const before = JSON.parse(JSON.stringify(store.get('browse-v1')));
    const page = await invoke('journal_browse', [{ scope: 'all', limit: 5 }]);
    const target = page.items.find((item: any) => item.bookKey === secondBook)!;
    const card = cards(root).find((item) => item.textContent!.includes(target.interpretation))!;
    [...card.querySelectorAll('button')].find((button) => button.textContent === '聊聊这一段')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-book-key]')).not.toBeNull());
    expect(root.querySelector<HTMLElement>('[data-book-key]')!.dataset.bookKey).toBe(secondBook);
    await sendDiscussion(root);
    await vi.waitFor(async () => {
      const fresh = await invoke('get', []) as any;
      expect(fresh.discussions.at(-1)?.bookKey).toBe(secondBook);
    }, { timeout: 6000 });
    const fresh = await invoke('get', []) as any;
    expect(fresh.discussions.at(-1)?.episodeId).toBe(target.id);
    expect(fresh.status.library.current.key).toBe(firstBook);
    const after = JSON.parse(JSON.stringify(store.get('browse-v1')));
    expect(after.scope).toBe(before.scope);
    expect(after.order).toBe(before.order);
    expect(after.limit).toBe(before.limit);
    expect(after.anchor).toBe(before.anchor);
    expect(bookSelect(root).value).toBe('');
    expect(cards(root).length).toBe(6);
  });

  it('keeps the same-book discussion path unchanged', async () => {
    const book = await seed('甲书', 3);
    const { root } = await mount();
    await vi.waitFor(() => expect(cards(root).length).toBe(3));
    [...cards(root)[0]!.querySelectorAll('button')].find((button) => button.textContent === '聊聊这一段')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-book-key]')).not.toBeNull());
    expect(root.querySelector<HTMLElement>('[data-book-key]')!.dataset.bookKey).toBe(book);
    await sendDiscussion(root);
    await vi.waitFor(async () => {
      const fresh = await invoke('get', []) as any;
      expect(fresh.discussions.at(-1)?.bookKey).toBe(book);
    }, { timeout: 6000 });
  });

  it('uses the record book when discussing from the new-footprint preview', async () => {
    const firstBook = await seed('甲书', 3); const secondBook = await seed('乙书', 3);
    await invoke('select', [firstBook]);
    const { root, poll } = await mount();
    await vi.waitFor(() => expect(cards(root).length).toBe(6));
    await poll();
    await tool('bookfish_record_reflection', { bookKey: secondBook, requestId: 'preview-discuss',
      episode: { trigger: '预览讨论', interpretation: '乙书预览里的新足迹', evidence: [{ segmentId: 0, quote: '海风轻轻吹过岸边' }] } });
    await poll();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('.bf-fp-banner')!.hidden).toBe(false));
    action(root, '查看新增').click();
    await vi.waitFor(() => expect(root.querySelectorAll('.bf-fp-preview-list .bf-fp-card')).toHaveLength(1));
    const previewCard = root.querySelector<HTMLElement>('.bf-fp-preview-list .bf-fp-card')!;
    [...previewCard.querySelectorAll('button')].find((button) => button.textContent === '聊聊这一段')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-book-key]')).not.toBeNull());
    expect(root.querySelector<HTMLElement>('[data-book-key]')!.dataset.bookKey).toBe(secondBook);
    await sendDiscussion(root);
    await vi.waitFor(async () => {
      const fresh = await invoke('get', []) as any;
      expect(fresh.discussions.at(-1)?.bookKey).toBe(secondBook);
    }, { timeout: 6000 });
  });

  it('filters the list by footprint keywords, pages the matches and clears back', async () => {
    const first = await seed('甲书', 3); const second = await seed('乙书', 3);
    for (let index = 0; index < 6; index++) {
      await tool('bookfish_record_reflection', { bookKey: index % 2 === 0 ? first : second, requestId: `kw-${index}`,
        episode: { trigger: `灯塔第 ${index} 次`, interpretation: `海边的灯塔 ${index}`, evidence: [{ segmentId: 0, quote: '海风轻轻吹过岸边' }] } });
    }
    const { root } = await mount();
    await vi.waitFor(() => expect(cards(root).length).toBe(10));
    const size = root.querySelector<HTMLSelectElement>('select[aria-label="每页数量"]')!;
    size.value = '5'; size.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(root.querySelector('.bf-fp-pager span')!.textContent).toContain('第 1 / 3 页'));
    const search = root.querySelector<HTMLInputElement>('input[aria-label="搜索足迹"]')!;
    search.value = '灯塔'; search.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(root.querySelector('.bf-fp-pager span')!.textContent).toContain('匹配 6 条 · 第 1 / 2 页'));
    expect(cards(root)).toHaveLength(5);
    expect(metatexts(root).every((text) => text?.includes('灯塔'))).toBe(true);
    action(root, '下一页').click(); await settle();
    await vi.waitFor(() => expect(root.querySelector('.bf-fp-pager span')!.textContent).toContain('第 2 / 2 页'));
    expect(cards(root)).toHaveLength(1);
    search.value = '不存在的词'; search.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(cards(root)).toHaveLength(0));
    expect(root.querySelector('.bf-fp-list')!.textContent).toContain('没有匹配');
    search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(cards(root)).toHaveLength(5));
    expect(root.querySelector('.bf-fp-pager span')!.textContent).toContain('共 12 条');
  });
});
