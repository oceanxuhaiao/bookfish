// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { BOOKFISH } from '../../src/definition.ts';
import type { BookfishConfigSection } from '../../src/config.ts';
import bundle from '../../src/webui/client.ts';
import { settingsPanel } from '../../src/webui/settings.ts';
import { FakeHost } from '../helpers/fake-host.ts';

let dir: string;
let controller: AbortController;
let world: ReturnType<typeof BOOKFISH.create>;
let host: FakeHost;
let dispose: (() => void) | undefined;
let drawers: Array<{ title: string; body: string | HTMLElement }> = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-help-client-'));
  const context = fakeWorldContext<BookfishConfigSection>(BOOKFISH, { scratchDir: dir });
  context.persist({ automaticReading: false, realRoutineEnabled: false });
  world = BOOKFISH.create(context);
  host = new FakeHost();
  await world.start(host);
  controller = new AbortController();
  drawers = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  dispose?.(); dispose = undefined;
  controller.abort();
  await world.stop();
  document.body.replaceChildren();
  rmSync(dir, { recursive: true, force: true });
});

async function mountPanel(panelId: string, ctxPatch: Partial<WebUiPanelContext> = {}): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.append(root);
  const ctx = {
    root, panelId, language: 'zh', signal: controller.signal,
    invoke: async (method: string, args: unknown[] = []) => world.webUi!('zh').invoke!(panelId, method, args),
    interval: () => ({ dispose() {} }), timeout: () => ({ dispose() {} }), own: <T,>(value: T) => value,
    ui: {
      confirm: async () => false, toast: () => ({ dispose() {} }),
      drawer: (title: string, body: string | HTMLElement) => { drawers.push({ title, body }); return { dispose() {} }; },
    },
    ...ctxPatch,
  } as unknown as WebUiPanelContext;
  const panel = panelId === 'settings' ? settingsPanel : (bundle.panels as Record<string, typeof bundle.panels.status>)[panelId]!;
  const handle = await panel.mount(ctx);
  dispose = () => handle.dispose();
  return root;
}
const flush = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 35)); };
const button = (root: ParentNode, text: string): HTMLButtonElement | undefined => [...root.querySelectorAll('button')].find((entry) => entry.textContent?.includes(text));

describe('help center entry and contextual help', () => {
  it('opens the guide from the BookFish navigation without navigating away from reading', async () => {
    const root = await mountPanel('status');
    const eventsBeforeHelp = host.events.length;
    const entry = button(root, '帮助与更新');
    expect(entry).toBeTruthy();
    entry!.click();
    await flush();
    expect(root.querySelector('.bf-help h2')?.textContent).toContain('功能指南');
    expect(root.querySelector<HTMLElement>('[data-page=help]')?.hidden).toBe(false);
    const first = root.querySelector<HTMLButtonElement>('.bf-help-item')!;
    first.click();
    await flush();
    expect(root.querySelector('.bf-help-body')?.textContent).toContain('怎么使用');
    const back = button(root, '返回功能目录');
    expect(back).toBeTruthy();
    back!.click();
    expect(root.querySelector<HTMLElement>('.bf-help-category')?.hidden).toBe(false);
    expect(host.events).toHaveLength(eventsBeforeHelp);
  });

  it('opens contextual help in a drawer and preserves unsaved settings edits', async () => {
    const root = await mountPanel('settings');
    const interval = root.querySelector<HTMLInputElement>('#bf-config-shareCooldownMinutes')!;
    interval.value = '95';
    interval.dispatchEvent(new Event('input', { bubbles: true }));
    const question = root.querySelector<HTMLButtonElement>('label[for="bf-config-automaticReading"] .bf-help-question');
    expect(question).toBeTruthy();
    question!.click();
    await flush();
    expect(drawers).toHaveLength(1);
    expect(drawers[0]!.title).toBe('功能说明');
    expect((drawers[0]!.body as HTMLElement).querySelector('.bf-help-body')?.textContent).toContain('自主阅读');
    expect(interval.value).toBe('95');
    expect(root.textContent).toContain('有未保存的修改');
  });
});
