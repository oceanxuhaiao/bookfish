// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BOOKFISH } from '../../src/definition.ts';
import bundle from '../../src/webui/client.ts';
import { FakeHost } from '../helpers/fake-host.ts';

/**
 * v1.5 UI guarantees, tested the way a user meets them:
 *
 *  - a refusal is visible while the batch is still a preview;
 *  - it survives closing and reopening the panel (the report is persisted);
 *  - an unsupported file in a folder is neither imported nor forgotten;
 *  - a failed first upload leaves a batch the panel can act on, with no reopen.
 */
let dir: string, world: ReturnType<typeof BOOKFISH.create>, controller: AbortController, dispose: (() => void) | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bookfish-batch-report-'));
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

/** A folder entry with the relative path the folder picker reports. */
function folderFile(title: string, relative: string): File {
  const file = new File([`# ${title}\n\n${'海浪。'.repeat(300)}`], relative.split('/').pop()!, { type: 'text/plain' });
  Object.defineProperty(file, 'webkitRelativePath', { value: relative, configurable: true });
  return file;
}

async function writeZip(entries: [string, Buffer][]): Promise<Buffer> {
  const yazl = await import('yazl');
  const file = join(dir, `archive-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`);
  const zip = new yazl.ZipFile();
  for (const [name, body] of entries) zip.addBuffer(body, name);
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(file);
    out.on('close', () => resolve()).on('error', reject);
    zip.outputStream.pipe(out);
  });
  return readFileSync(file);
}

describe('a preview batch already shows what it refused', () => {
  it('shows the report for a folder pick containing an unsupported file, before starting', async () => {
    const root = await mount();
    const batch = root.querySelector('.bf-batch') as HTMLElement;
    attach(picker(root, 'folder'), [
      folderFile('第一部', '小说文件夹/第一部.txt'),
      folderFile('第二部', '小说文件夹/第二部.txt'),
      new File(['jpeg'], '封面.jpg', { type: 'image/jpeg' }),
      new File(['pdf'], '说明.pdf', { type: 'application/pdf' }),
    ]);
    await waitFor(() => batch.textContent!.includes('导入所选'), 'folder preview');

    // The batch has NOT been started, yet the refusal is already on screen.
    const text = batch.textContent!;
    expect(text).toContain('本次结果');
    expect(text).toContain('格式不支持 1 个');
    // The refused name is kept, not just a count.
    expect(text).toContain('封面.jpg');
    // .pdf IS a supported book format, so it was accepted, not refused: the
    // point here is that the classifier runs server-side, on the real names.
    expect(text).toContain('共 3 本');
  });

  it('keeps the report after closing and reopening the panel', async () => {
    const invoke = world.webUi!('zh').invoke!;
    // Build the batch directly so the test isolates persistence, not the picker.
    const created = await invoke('shelf', 'import_batch_create', [{ source: 'folder' }]) as { id: string };
    await invoke('shelf', 'import_batch_add', [created.id, [
      { name: '小说文件夹/第一部.txt', size: 120 },
      { name: '小说文件夹/封面.jpg', size: 40 },
      { name: '小说文件夹/说明.txt', size: 130 },
      { name: '小说文件夹/说明.txt', size: 130 },
    ]]);

    const first = await mount();
    const firstBatch = first.querySelector('.bf-batch') as HTMLElement;
    await waitFor(() => firstBatch.textContent!.includes('未完成 1 批'), 'history entry');
    const open = [...firstBatch.querySelectorAll('button')].find((node) => node.textContent!.includes('第一部'));
    expect(open).toBeTruthy();
    open!.click();
    await waitFor(() => firstBatch.textContent!.includes('格式不支持 1 个'), 'report on first mount');
    expect(firstBatch.textContent).toContain('封面.jpg');

    // A remount is what closing and reopening the panel looks like: the
    // transient `error` text is gone, the persisted report is not.
    dispose?.(); dispose = undefined;
    const second = await mount();
    const secondBatch = second.querySelector('.bf-batch') as HTMLElement;
    await waitFor(() => secondBatch.textContent!.includes('未完成 1 批'), 'history after remount');
    [...secondBatch.querySelectorAll('button')].find((node) => node.textContent!.includes('第一部'))!.click();
    await waitFor(() => secondBatch.textContent!.includes('格式不支持 1 个'), 'report survives remount');
    expect(secondBatch.textContent).toContain('封面.jpg');
    // The duplicate is still counted, so the reload did not reset the numbers.
    expect(secondBatch.textContent).toMatch(/重复或无效 1 个/u);
  });

  it('records a batch that contains only unsupported files instead of failing silently', async () => {
    const root = await mount();
    const batch = root.querySelector('.bf-batch') as HTMLElement;
    attach(picker(root, 'folder'), [
      new File(['jpeg'], '封面.jpg', { type: 'image/jpeg' }),
      new File(['png'], '插图.png', { type: 'image/png' }),
    ]);
    await waitFor(() => batch.textContent!.includes('格式不支持 2 个'), 'all-unsupported report');
    const text = batch.textContent!;
    expect(text).toContain('封面.jpg');
    expect(text).toContain('插图.png');
    // The batch exists and is reachable from the history; it is not a dead end
    // with no record anywhere.
    const summaries = await world.webUi!('zh').invoke!('shelf', 'import_batch_status', []) as Array<{ total: number }>;
    expect(summaries).toHaveLength(1);
    expect(summaries[0].total).toBe(0);
  });
});

describe('a failed first attempt still leaves a batch the panel can act on', () => {
  it('recovers the view when the very first ZIP upload fails to extract', async () => {
    // A .zip the picker accepts but the extractor cannot open: the batch record
    // is created FIRST, then the first attempt fails. Without the refresh in
    // `fail()` this is the dead end v1.4 had — an error message, an empty body,
    // and no batch in the history to click.
    const garbage = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(512, 7)]);
    const root = await mount();
    const batch = root.querySelector('.bf-batch') as HTMLElement;
    attach(picker(root, 'zip'), [new File([garbage], 'broken.zip')]);

    await waitFor(() => {
      const error = batch.querySelector('.batch-error') as HTMLElement | null;
      return !!error && !!error.textContent && !batch.textContent!.includes('正在读取压缩包');
    }, 'first-upload failure', 60_000);

    // 1. The original reason is preserved.
    const errorText = (batch.querySelector('.batch-error') as HTMLElement).textContent!;
    expect(errorText.length).toBeGreaterThan(0);
    // 2. The batch itself is on screen: its archive block is rendered from the
    //    server state that `fail()` re-read, not from a stale local guess.
    expect(batch.textContent).toContain('broken.zip');
    expect(batch.textContent).toContain('压缩包');
    // 3. The record exists in the history, so a remount would find it too.
    const summaries = await world.webUi!('zh').invoke!('shelf', 'import_batch_status', []) as Array<{ id: string }>;
    expect(summaries).toHaveLength(1);
    // 4. The verified-bytes recovery is offered: the archive is still there and
    //    the failure is retryable, never "pick it again".
    const status = await world.webUi!('zh').invoke!('shelf', 'import_batch_status', [summaries[0].id]) as {
      zip?: { state: string; failure?: string; reselectable: boolean };
    };
    expect(status.zip?.state).toBe('ready');
    expect(status.zip?.failure).toBe('transient');
    expect(status.zip?.reselectable).toBe(false);
    expect(batch.textContent).toContain('重试解压');
  });

  it('shows the over-limit archive it refused without needing a reopen', async () => {
    const entries: [string, Buffer][] = Array.from({ length: 120 },
      (_, index) => [`书${String(index).padStart(3, '0')}.txt`, Buffer.from(`# 书${index}\n` + 'text. '.repeat(40))] as [string, Buffer]);
    const bytes = await writeZip(entries);
    const root = await mount();
    const batch = root.querySelector('.bf-batch') as HTMLElement;
    // `Buffer` is typed over `ArrayBufferLike` (which includes SharedArrayBuffer),
    // so it is not a `BlobPart` directly; the copy is a few KiB and keeps the DOM
    // signature honest instead of casting the buffer.
    attach(picker(root, 'zip'), [new File([Uint8Array.from(bytes)], 'too-many.zip')]);

    // The failure surfaces AND the panel re-reads the batch it just created.
    await waitFor(() => {
      const error = batch.querySelector('.batch-error') as HTMLElement | null;
      return !!error && !!error.textContent && !batch.textContent!.includes('正在读取压缩包');
    }, 'over-limit refusal', 60_000);
    const text = batch.textContent!;
    expect(text).toContain('超过单批');
    expect(text).toContain('拆');
    // The archive block is rendered from the re-read state: this is the recovery
    // that v1.4 lacked (an error with no batch to look at).
    expect(text).toContain('too-many.zip');
    expect(text).toContain('压缩包已保留');
    // And the persisted refusal is reachable through the same panel.
    const summaries = await world.webUi!('zh').invoke!('shelf', 'import_batch_status', []) as Array<{ id: string }>;
    expect(summaries).toHaveLength(1);
    const status = await world.webUi!('zh').invoke!('shelf', 'import_batch_status', [summaries[0].id]) as {
      zip?: { failure?: string; rejection?: { kind: string; books: number | null; archiveKept: boolean } };
      report: { archiveRejected: { kind: string } | null };
    };
    expect(status.zip?.failure).toBe('over_limit');
    expect(status.zip?.rejection?.kind).toBe('count');
    expect(status.zip?.rejection?.archiveKept).toBe(true);
    expect(status.zip?.rejection?.books).toBe(120);
    expect(status.report.archiveRejected).not.toBeNull();
  });
});