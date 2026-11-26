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
    ui: { drawer: (_title:string, body:HTMLElement) => { root.append(body); return {dispose(){body.remove();}}; }, confirm: async () => true, toast: () => ({ dispose() {} }) },
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
    expect(batch.textContent).toContain('本地导入');
    attach(picker(root, 'files'), [novel('甲'), novel('乙')]);
    await waitFor(() => batch.textContent!.includes('导入所选'), 'batch preview');
    expect(batch.textContent).toContain('共 2 本');
    expect(batch.textContent).toContain('《甲》');
    // Importing has not started, so the shelf is still empty.
    expect((await world.webUi!('zh').invoke!('shelf', 'get', []) as { books: unknown[] }).books).toHaveLength(0);

    [...batch.querySelectorAll('button')].find((node) => node.textContent?.startsWith('导入所选'))!.click();
    await waitFor(() => batch.textContent!.includes('加入阅读顺序'), 'batch completion', 60_000);
    expect((await world.webUi!('zh').invoke!('shelf', 'get', []) as { books: unknown[] }).books).toHaveLength(2);
    expect((await world.webUi!('zh').invoke!('shelf', 'get', []) as { plan: { total: number } }).plan.total).toBe(0);

    [...batch.querySelectorAll('button')].find((node) => node.textContent === '选择书籍加入阅读顺序')!.click();
    for(const check of batch.querySelectorAll<HTMLInputElement>('.batch-item input[type=checkbox]')){check.checked=true;check.dispatchEvent(new Event('change'));}
    [...batch.querySelectorAll('button')].find(node=>node.textContent?.startsWith('加入阅读顺序（'))!.click();
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
    await waitFor(() => batch.textContent!.includes('导入所选'), 'folder preview');
    expect(batch.textContent).toContain('长篇小说');
    expect(batch.textContent).toContain('也可能是一本书拆开的多份');
    expect((await world.webUi!('zh').invoke!('shelf', 'get', []) as { plan: { total: number } }).plan.total).toBe(0);
  });

  it('reports unsupported files instead of importing them', async () => {
    const root = await mount();
    const batch = root.querySelector('.bf-batch') as HTMLElement;
    attach(picker(root, 'files'), [novel('甲'), new File(['x'], '封面.jpg', { type: 'image/jpeg' })]);
    await waitFor(() => batch.textContent!.includes('导入所选'), 'mixed preview');
    expect(batch.textContent).toContain('共 1 本');
    // v1.5: the refusal is in the persisted report, not a transient error line.
    // It is visible while the batch is STILL A PREVIEW, which is when the user
    // can still act on it.
    expect(batch.textContent).toContain('格式不支持 1 个');
    expect(batch.textContent).toContain('封面.jpg');
  });
});

describe('recovery, cancellation and reselect from the panel', () => {
  it('cancels one item while the others keep importing', async () => {
    const root = await mount();
    const batch = root.querySelector('.bf-batch') as HTMLElement;
    attach(picker(root, 'files'), [novel('甲'), novel('乙')]);
    await waitFor(() => batch.textContent!.includes('导入所选'), 'preview');
    [...batch.querySelectorAll('button')].find((node) => node.textContent?.startsWith('导入所选'))!.click();
    await settle(120);
    const cancel = [...batch.querySelectorAll('button')].find((node) => node.textContent === '取消这本');
    expect(cancel).toBeTruthy();
    cancel!.click();
    await waitFor(() => batch.textContent!.includes('加入阅读顺序'), 'batch settles', 60_000);
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
    await waitFor(() => batch.textContent!.includes('导入所选'), 'reopened batch');
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
    await waitFor(() => batch.textContent!.includes('导入所选'), 'preview');
    [...batch.querySelectorAll('button')].find((node) => node.textContent?.startsWith('导入所选'))!.click();
    await waitFor(() => batch.textContent!.includes('加入阅读顺序'), 'completion', 60_000);
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
    // The wrong claim is pinned, so this record IS re-pickable — but only for
    // the archive that digest describes. The real file never matches it.
    expect(await invoke('shelf', 'import_batch_status', [created.id]) as { zip: { reselectable: boolean } })
      .toMatchObject({ zip: { reselectable: true } });

    [...batch.querySelectorAll('button')].find((node) => node.textContent === '重新选择 ZIP')!.click();
    await settle(60);
    const zipInput = root.querySelector<HTMLInputElement>('input[type=file][accept=".zip"]')!;
    Object.defineProperty(zipInput, 'files', { value: [new File([bytes], 'books.zip')], configurable: true });
    zipInput.dispatchEvent(new Event('change'));

    // The picked file hashes to something other than the pinned claim, so the
    // panel refuses BEFORE uploading (the server would refuse it anyway) and
    // points at the honest escape hatch: a new batch, this record kept.
    await waitFor(() => {
      const error = batch.querySelector('.batch-error') as HTMLElement | null;
      return !!error && !!error.textContent;
    }, 'refusal surfaces', 30_000);
    const errorText = (batch.querySelector('.batch-error') as HTMLElement).textContent!;
    expect(/压缩包|batch/u.test(errorText)).toBe(true);
    // The batch is unchanged: re-opened but unverified, no second batch was
    // created, and nothing was imported under a false identity.
    const after = await invoke('shelf', 'import_batch_status', [created.id]) as { id: string; zip?: { state: string; sha256?: string; reselectable: boolean } };
    expect(after.id).toBe(created.id);
    // The re-pick re-opened the upload slot, but nothing was accepted.
    expect(['needs_reselect', 'uploading']).toContain(after.zip?.state);
    expect(after.zip?.sha256).toBeUndefined();
    const state = await invoke('shelf', 'get', []) as { importBatches: Array<{ id: string; zip?: { claimedSha256?: string } }> };
    expect(state.importBatches).toHaveLength(1);
    // The pinned claim survived every refusal: it is the standing identity
    // constraint, visible to the panel as "reselectable".
    expect(state.importBatches[0]?.zip?.claimedSha256).toBe('a'.repeat(64));
    expect(after.zip?.reselectable).toBe(true);
  });

  it('summarises what was refused instead of presenting a partial import as success', async () => {
    const root = await mount();
    const batch = root.querySelector('.bf-batch') as HTMLElement;
    // Two picks with the same name: the server keeps one and files the other as a
    // duplicate. That rejection has to be visible, not swallowed.
    attach(picker(root, 'files'), [novel('甲'), novel('甲'), new File(['x'], '封面.jpg', { type: 'image/jpeg' })]);
    await waitFor(() => batch.textContent!.includes('导入所选'), 'preview');
    [...batch.querySelectorAll('button')].find((node) => node.textContent?.startsWith('导入所选'))!.click();
    await waitFor(() => batch.textContent!.includes('本次结果'), 'result report');
    const text = batch.textContent!;
    expect(text).toContain('未进入本批');
    expect(text).toMatch(/重复或无效 1 个/u);
    // The unsupported pick is reported in the same persisted report, with its
    // name, instead of a one-off client-side note that a remount would erase.
    expect(text).toContain('格式不支持 1 个');
    expect(text).toContain('封面.jpg');
    // And it says what to do about it, rather than pretending nothing is missing.
    expect(text).toContain('可以再选一次');
  });

  it('surfaces an over-limit archive refusal and tells the user to split it', async () => {
    const yazl = await import('yazl');
    const zipPath = join(dir, 'too-many.zip');
    const zip = new yazl.ZipFile();
    for (let index = 0; index < 120; index += 1) {
      zip.addBuffer(Buffer.from(`# 书${index}\n` + 'text. '.repeat(40)), `书${String(index).padStart(3, '0')}.txt`);
    }
    zip.end();
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(zipPath);
      out.on('close', () => resolve()).on('error', reject);
      zip.outputStream.pipe(out);
    });
    const bytes = readFileSync(zipPath);

    const root = await mount();
    const batch = root.querySelector('.bf-batch') as HTMLElement;
    attach(picker(root, 'zip'), [new File([bytes], 'too-many.zip')]);
    await waitFor(() => {
      const error = batch.querySelector('.batch-error') as HTMLElement | null;
      return !!error && !!error.textContent;
    }, 'over-limit refusal');
    const errorText = (batch.querySelector('.batch-error') as HTMLElement).textContent!;
    expect(errorText).toContain('超过单批');
    expect(errorText).toContain('拆');
    // Nothing was imported, and the archive record is kept for the user.
    const status = await world.webUi!('zh').invoke!('shelf', 'import_batch_status', []) as Array<{ total: number; completed: number }>;
    expect(status[0]?.total).toBe(0);
    expect(status[0]?.completed).toBe(0);
  });
});


it('imports only checked preview rows and offers a separate empty selection for the reading order',async()=>{
  const root=await mount();const batch=root.querySelector<HTMLElement>('.bf-batch')!;
  attach(picker(root,'files'),[novel('甲'),novel('乙'),novel('丙')]);
  await waitFor(()=>batch.textContent!.includes('导入所选 3 本'),'preview');
  const check=batch.querySelector<HTMLInputElement>('input[aria-label="选择：乙"]')!;
  check.checked=false;check.dispatchEvent(new Event('change'));
  [...batch.querySelectorAll('button')].find(node=>node.textContent==='导入所选 2 本')!.click();
  await waitFor(()=>batch.textContent!.includes('选择书籍加入阅读顺序'),'completion');
  const before=await world.webUi!('zh').invoke!('shelf','get',[]) as {books:{title:string}[];plan:{total:number}};
  expect(before.books.map(row=>row.title).sort()).toEqual(['丙','甲']);expect(before.plan.total).toBe(0);
  [...batch.querySelectorAll('button')].find(node=>node.textContent==='选择书籍加入阅读顺序')!.click();
  expect([...batch.querySelectorAll('button')].find(node=>node.textContent==='加入阅读顺序（0 本）')!.disabled).toBe(true);
  const one=batch.querySelector<HTMLInputElement>('input[aria-label="选择：甲"]')!;one.checked=true;one.dispatchEvent(new Event('change'));
  [...batch.querySelectorAll('button')].find(node=>node.textContent==='加入阅读顺序（1 本）')!.click();
  await waitFor(async()=>((await world.webUi!('zh').invoke!('shelf','get',[])) as {plan:{total:number}}).plan.total===1,'selected hand-off');
});
