// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWriteStream, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BOOKFISH } from '../../src/definition.ts';
import bundle from '../../src/webui/client.ts';
import { FakeHost } from '../helpers/fake-host.ts';
import { batchStagingName } from '../../src/import-batch.ts';

let dir: string, world: ReturnType<typeof BOOKFISH.create>, controller: AbortController, dispose: (() => void) | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-batch-ui-'));
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
  const ctx = { root, panelId: 'shelf', language: 'zh', signal: controller.signal,
    invoke: async (method: string, args: unknown[]) => world.webUi!('zh').invoke!('shelf', method, args),
    setConfig: async () => 'Saved', interval: () => {}, timeout: () => {}, own: () => {},
    ui: { confirm: async () => true, toast: () => ({ dispose() {} }) },
  } as unknown as WebUiPanelContext;
  const handle = await bundle.panels.shelf.mount(ctx);
  dispose = () => handle.dispose();
  return root;
}
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeout = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    // Async predicates are awaited: a bare Promise is always truthy.
    if (await predicate()) return;
    await settle(60);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function picker(root: HTMLElement, kind: 'files' | 'folder' | 'zip'): HTMLInputElement {
  const inputs = [...root.querySelectorAll<HTMLInputElement>('input[type=file]')];
  const found = inputs.find((input) => kind === 'zip' ? input.accept === '.zip'
    : kind === 'folder' ? (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory === true
    : input.multiple && !(input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory && input.accept.includes('.txt'));
  if (!found) throw new Error('picker not found');
  return found;
}

function attach(input: HTMLInputElement, files: File[]): void {
  const list = Object.assign([...files], { item: (index: number) => files[index] ?? null }) as unknown as FileList;
  Object.defineProperty(input, 'files', { value: list, configurable: true });
  input.dispatchEvent(new Event('change'));
}

const novel = (title: string) => new File([`# ${title}\n\n${'海风。'.repeat(400)}`], `${title}.txt`, { type: 'text/plain' });

/** Locate a staging file without assuming how the host lays out its scratch dir. */
function findStaged(batchId: string, name: string): string {
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.name === name && full.includes(batchId)) return full;
    }
  }
  throw new Error(`staging file not found: ${name}`);
}

describe('shelf batch import panel', () => {
  it('previews several files, imports them and only then offers the plan', async () => {
    const root = await mount();
    const batch = root.querySelector('.bf-batch') as HTMLElement;
    expect(batch).toBeTruthy();
    expect(batch.textContent).toContain('批量导入');
    attach(picker(root, 'files'), [novel('甲'), novel('乙')]);
    await waitFor(() => batch.textContent!.includes('开始导入'), 'batch preview');
    expect(batch.textContent).toContain('共 2 本');
    expect(batch.textContent).toContain('《甲》');
    // Importing has not started, so the shelf is still empty.
    expect((await world.webUi!('zh').invoke!('shelf', 'get', []) as { books: unknown[] }).books).toHaveLength(0);

    [...batch.querySelectorAll('button')].find((node) => node.textContent === '开始导入')!.click();
    await waitFor(() => batch.textContent!.includes('加入阅读计划'), 'batch completion', 60_000);
    expect((await world.webUi!('zh').invoke!('shelf', 'get', []) as { books: unknown[] }).books).toHaveLength(2);
    expect((await world.webUi!('zh').invoke!('shelf', 'get', []) as { plan: { total: number } }).plan.total).toBe(0);

    [...batch.querySelectorAll('button')].find((node) => node.textContent === '加入阅读计划')!.click();
    await waitFor(() => batch.textContent!.includes('再导一批'), 'plan hand-off');
    await settle(120);
    expect((await world.webUi!('zh').invoke!('shelf', 'get', []) as { plan: { total: number } }).plan.total).toBe(2);
  });

  it('keeps a folder split as one ambiguous group and never merges it silently', async () => {
    const root = await mount();
    const batch = root.querySelector('.bf-batch') as HTMLElement;
    const first = new File(['# 一\n' + '海风。'.repeat(200)], '1.txt', { type: 'text/plain' });
    Object.defineProperty(first, 'webkitRelativePath', { value: '长篇小说/1.txt', configurable: true });
    const second = new File(['# 二\n' + '海浪。'.repeat(200)], '2.txt', { type: 'text/plain' });
    Object.defineProperty(second, 'webkitRelativePath', { value: '长篇小说/2.txt', configurable: true });
    attach(picker(root, 'folder'), [first, second]);
    await waitFor(() => batch.textContent!.includes('开始导入'), 'folder preview');
    expect(batch.textContent).toContain('长篇小说');
    expect(batch.textContent).toContain('也可能是一本书拆开的多份');
    expect((await world.webUi!('zh').invoke!('shelf', 'get', []) as { plan: { total: number } }).plan.total).toBe(0);
  });

  it('reports unsupported files instead of importing them', async () => {
    const root = await mount();
    const batch = root.querySelector('.bf-batch') as HTMLElement;
    attach(picker(root, 'files'), [novel('甲'), new File(['x'], '封面.jpg', { type: 'image/jpeg' })]);
    await waitFor(() => batch.textContent!.includes('开始导入'), 'mixed preview');
    expect(batch.textContent).toContain('共 1 本');
    expect(batch.textContent).toContain('已跳过 1 个不支持的文件');
  });
});

describe('recovery, cancellation and reselect from the panel', () => {
  it('cancels one item while the others keep importing', async () => {
    const root = await mount();
    const batch = root.querySelector('.bf-batch') as HTMLElement;
    attach(picker(root, 'files'), [novel('甲'), novel('乙')]);
    await waitFor(() => batch.textContent!.includes('开始导入'), 'preview');
    [...batch.querySelectorAll('button')].find((node) => node.textContent === '开始导入')!.click();
    await settle(120);
    const cancel = [...batch.querySelectorAll('button')].find((node) => node.textContent === '取消这本');
    expect(cancel).toBeTruthy();
    cancel!.click();
    await waitFor(() => batch.textContent!.includes('加入阅读计划'), 'batch settles', 60_000);
    const rows = world.webUi!('zh').invoke!('shelf', 'get', []) as Promise<{ importBatches: { items: { status: string }[] }[] }>;
    const statuses = (await rows).importBatches[0].items.map((item) => item.status).sort();
    expect(statuses).toEqual(['cancelled', 'completed']);
  });

  it('offers the way back into an unfinished batch after a remount', async () => {
    const invoke = world.webUi!('zh').invoke!;
    const body = Buffer.from('# 待续\n\n' + 'the sea is wide. '.repeat(20));
    const created = await invoke('shelf', 'import_batch_create', [{ source: 'files' }]) as { id: string };
    const added = await invoke('shelf', 'import_batch_add', [created.id, [{ name: '待续.txt', size: body.length }]]) as { added: { id: string }[] };
    await invoke('shelf', 'import_batch_chunk', [created.id, added.added[0].id, 0, body.toString('base64')]);

    // A fresh mount is what a restarted host looks like to the user.
    dispose?.(); dispose = undefined;
    const root = await mount();
    const batch = root.querySelector('.bf-batch') as HTMLElement;
    await waitFor(() => batch.textContent!.includes('未完成 1 批'), 'history entry');
    const open = [...batch.querySelectorAll('button')].find((node) => node.textContent!.includes('待续'));
    expect(open).toBeTruthy();
    open!.click();
    await waitFor(() => batch.textContent!.includes('开始导入'), 'reopened batch');
    expect(batch.textContent).toContain('《待续》');
  });

  it('lets the user pick the lost file again and finishes the same entry', async () => {
    const invoke = world.webUi!('zh').invoke!;
    const body = Buffer.from('# 丢失\n\n' + 'the sea is wide. '.repeat(20));
    const created = await invoke('shelf', 'import_batch_create', [{ source: 'files' }]) as { id: string };
    const added = await invoke('shelf', 'import_batch_add', [created.id, [{ name: '丢失.txt', size: body.length }]]) as { added: { id: string }[] };
    const itemId = added.added[0].id;
    // A first complete upload establishes the content identity the re-pick must match.
    await invoke('shelf', 'import_batch_chunk', [created.id, itemId, 0, body.toString('base64')]);
    // Then the staging bytes are truncated, so the real length can never match.
    const staged = findStaged(created.id, batchStagingName(itemId));
    writeFileSync(staged, body.subarray(0, 10));
    await invoke('shelf', 'import_batch_start', [created.id]);
    await waitFor(() => batchStatus(invoke, created.id, 'needs_reselect'), 'needs_reselect', 30_000);

    const root = await mount();
    const batch = root.querySelector('.bf-batch') as HTMLElement;
    await waitFor(() => batch.textContent!.includes('需重新选择'), 'reselect hint');
    // The history line is what a fresh mount shows; open the batch to reach the item.
    const entry = [...batch.querySelectorAll('button')].find((node) => node.textContent!.includes('丢失'));
    expect(entry).toBeTruthy();
    entry!.click();
    await waitFor(() => batch.textContent!.includes('《丢失》'), 'batch detail');
    const reselect = [...batch.querySelectorAll('button')].find((node) => node.textContent === '重新选择文件');
    expect(reselect).toBeTruthy();
    reselect!.click();

    const reselectInput = root.querySelector<HTMLInputElement>('input[data-role=batch-reselect]');
    expect(reselectInput).toBeTruthy();
    Object.defineProperty(reselectInput!, 'files', { value: [new File([body], '丢失.txt')], configurable: true });
    reselectInput!.dispatchEvent(new Event('change'));

    await waitFor(() => batchStatus(invoke, created.id, 'completed'), 'reselect completes', 60_000);
    const detail = await invoke('shelf', 'get', []) as { importBatches: { items: { id: string; status: string }[] }[] };
    expect(detail.importBatches[0].items).toHaveLength(1);
    expect(detail.importBatches[0].items[0]).toMatchObject({ id: itemId, status: 'completed' });
  });

  it('forgets a finished batch record without touching the books', async () => {
    const root = await mount();
    const batch = root.querySelector('.bf-batch') as HTMLElement;
    attach(picker(root, 'files'), [novel('甲')]);
    await waitFor(() => batch.textContent!.includes('开始导入'), 'preview');
    [...batch.querySelectorAll('button')].find((node) => node.textContent === '开始导入')!.click();
    await waitFor(() => batch.textContent!.includes('加入阅读计划'), 'completion', 60_000);
    const forget = [...batch.querySelectorAll('button')].find((node) => node.textContent === '清理记录');
    expect(forget).toBeTruthy();
    forget!.click();
    await waitFor(() => !batch.textContent!.includes('导入记录'), 'record removed');
    const state = await world.webUi!('zh').invoke!('shelf', 'get', []) as { books: unknown[]; importBatches: unknown[] };
    expect(state.importBatches).toEqual([]);
    expect(state.books).toHaveLength(1);
  });
});

async function batchStatus(invoke: (panel: string, method: string, args: unknown[]) => Promise<unknown>, batchId: string, wanted: string): Promise<boolean> {
  const view = await invoke('shelf', 'import_batch_status', [batchId]) as { items: { status: string }[] };
  return view.items[0]?.status === wanted;
}

describe('an interrupted archive can be picked again from the panel', () => {
  it('shows the archive state and re-uploads the same ZIP', async () => {
    const yazl = await import('yazl');
    const zipPath = join(dir, 'books.zip');
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('# 甲\n' + 'the sea is wide. '.repeat(60)), '甲.txt');
    zip.addBuffer(Buffer.from('# 乙\n' + 'the tide is low. '.repeat(60)), '乙.txt');
    zip.end();
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(zipPath);
      out.on('close', () => resolve()).on('error', reject);
      zip.outputStream.pipe(out);
    });
    const bytes = readFileSync(zipPath);
    const invoke = world.webUi!('zh').invoke!;
    const created = await invoke('shelf', 'import_batch_create', [{ source: 'zip' }]) as { id: string };
    // A client digest that cannot match: the server refuses and asks again.
    await invoke('shelf', 'import_batch_zip_begin', [created.id, { name: 'books.zip', size: bytes.length, sha256: 'a'.repeat(64) }]);
    await invoke('shelf', 'import_batch_zip_chunk', [created.id, 0, bytes.toString('base64')]);
    await expect(invoke('shelf', 'import_batch_zip_finish', [created.id])).rejects.toThrow('does not match the selected file');
    const status = await invoke('shelf', 'import_batch_status', [created.id]) as { zip: { state: string } };
    expect(status.zip.state).toBe('needs_reselect');

    const root = await mount();
    const batch = root.querySelector('.bf-batch') as HTMLElement;
    await waitFor(() => batch.textContent!.includes('未完成 1 批'), 'history');
    [...batch.querySelectorAll('button')].find((node) => node.textContent!.includes('books.zip'))!.click();
    await waitFor(() => batch.textContent!.includes('重新选择 ZIP'), 'archive reselect entry');
    expect(batch.textContent).toContain('上传已中断');

    [...batch.querySelectorAll('button')].find((node) => node.textContent === '重新选择 ZIP')!.click();
    await settle(60);
    const zipInput = root.querySelector<HTMLInputElement>('input[type=file][accept=".zip"]')!;
    Object.defineProperty(zipInput, 'files', { value: [new File([bytes], 'books.zip')], configurable: true });
    zipInput.dispatchEvent(new Event('change'));

    // The archive itself is verified here; extraction runs in a worker thread,
    // which the jsdom environment cannot start, so that half is covered by the
    // Node-environment tests (tests/import-batch-zip-peak.test.ts).
    await waitFor(async () => {
      const view = await invoke('shelf', 'import_batch_status', [created.id]) as { zip?: { sha256?: string; state: string } };
      return Boolean(view.zip?.sha256);
    }, 'archive re-verified', 30_000);
    const after = await invoke('shelf', 'import_batch_status', [created.id]) as { id: string; zip?: { sha256?: string; state: string } };
    expect(after.id).toBe(created.id);
    expect(after.zip?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const state = await invoke('shelf', 'get', []) as { importBatches: unknown[] };
    // Re-uploading resumed the same batch instead of creating a second one.
    expect(state.importBatches).toHaveLength(1);
  });
});
