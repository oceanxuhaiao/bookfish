// @vitest-environment jsdom
import { afterEach, beforeEach, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { BOOKFISH } from '../../src/definition.ts';
import type { BookfishConfigSection } from '../../src/config.ts';
import client from '../../src/webui/client.ts';

let dir: string, controller: AbortController, root: HTMLElement, context: ReturnType<typeof fakeWorldContext<BookfishConfigSection>>, world: ReturnType<typeof BOOKFISH.create>, dispose: (() => void) | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bf-import-method-'));
  context = fakeWorldContext<BookfishConfigSection>(BOOKFISH, { scratchDir: dir });
  world = BOOKFISH.create(context);
  controller = new AbortController();
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => { dispose?.(); controller.abort(); document.body.replaceChildren(); rmSync(dir, { recursive: true, force: true }); });

async function mount() {
  const handle = await client.panels.shelf.mount({
    root, language: 'zh', panelId: 'shelf', signal: controller.signal,
    interval: () => () => {},
    invoke: (method: string, args?: unknown[]) => world.webUi!('zh').invoke!('status', method, args ?? []),
  } as unknown as WebUiPanelContext);
  dispose = () => handle.dispose();
}

it('groups the three import methods in one selector and marks experiments', async () => {
  await mount();
  const recommend = root.querySelector<HTMLElement>('#bf-recommend-panel')!;
  expect(recommend.hidden).toBe(true);
  const picker = recommend.querySelector<HTMLSelectElement>('select[aria-label="导入方式"]')!;
  expect([...picker.options].map(option => option.textContent)).toEqual(['文件导入', '链接获取', '书名或作者获取']);
  expect(recommend.querySelector('.badge.experimental')?.textContent).toBe('实验功能');

  const add = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('推荐一本书'))!;
  add.click();
  expect(recommend.hidden).toBe(false);
  const forms = [...recommend.querySelectorAll('form')];
  expect(forms).toHaveLength(3);
  expect(forms[0].parentElement?.hidden).toBe(false);
  expect(forms[1].parentElement?.hidden).toBe(true);
  expect(root.querySelector<HTMLElement>('#bf-novel-fetch')?.hidden).toBe(true);

  picker.value = 'link'; picker.dispatchEvent(new Event('change', { bubbles: true }));
  expect(forms[0].parentElement?.hidden).toBe(true);
  expect(forms[1].parentElement?.hidden).toBe(false);
  expect(root.querySelector<HTMLElement>('#bf-novel-fetch')?.hidden).toBe(true);

  picker.value = 'title'; picker.dispatchEvent(new Event('change', { bubbles: true }));
  expect(forms[0].parentElement?.hidden).toBe(true);
  expect(forms[1].parentElement?.hidden).toBe(true);
  expect(root.querySelector<HTMLElement>('#bf-novel-fetch')?.hidden).toBe(false);
  const gate = root.querySelector<HTMLElement>('#bf-novel-fetch .novel-engine-gate')!;
  expect(gate.hidden).toBe(false);
  expect(gate.textContent).toContain('需要先安装小说获取引擎');
  expect(gate.compareDocumentPosition(forms[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
