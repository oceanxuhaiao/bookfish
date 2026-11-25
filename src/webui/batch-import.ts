/**
 * WebUI: batch import (several files, a folder or a ZIP) plus the recovery
 * surface for batches that a restart interrupted.
 *
 * Preview first, import second, plan third — three separate decisions. Nothing
 * here parses a file: the bytes go to the same staging worker a single-file
 * import uses, and the server owns every status transition and every limit.
 */
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { ImportBatch, ImportBatchSummary, ImportBatchView } from './batch-types.ts';
import { fileSha256Hex } from './sha256.ts';

export interface BatchImportHandle { root: HTMLElement; dispose(): void }

const NOVEL = /\.(txt|md|epub|pdf)$/iu;
const ZIP = /\.zip$/iu;

type Say = (zh: string, english: string) => string;

const STATUS_TEXT: Record<string, [string, string]> = {
  pending: ['等待中', 'Waiting'],
  importing: ['上传中', 'Uploading'],
  processing: ['正在解析', 'Parsing'],
  validating: ['正在入库', 'Committing'],
  completed: ['已入库', 'Imported'],
  failed: ['失败', 'Failed'],
  cancelled: ['已取消', 'Cancelled'],
  needs_reselect: ['需重新选择', 'Needs reselect'],
};
const BATCH_TEXT: Record<string, [string, string]> = {
  preview: ['待开始', 'Ready'],
  running: ['进行中', 'Running'],
  completed: ['已完成', 'Done'],
  cancelled: ['已取消', 'Cancelled'],
};

interface State {
  batch: ImportBatch | null;
  view: ImportBatchView | null;
  summaries: ImportBatchSummary[];
  busy: string | null;
  error: string | null;
  reselectItemId: string | null;
  /** Set when the zip picker is being used to re-attach an interrupted archive. */
  reselectZipId: string | null;
  /** Digest a re-attached archive must hash to, when the server pinned one. */
  expectedZipSha256: string | null;
}

export function mountBatchImport(ctx: WebUiPanelContext, say: Say): BatchImportHandle {
  const state: State = { batch: null, view: null, summaries: [], busy: null, error: null, reselectItemId: null, reselectZipId: null, expectedZipSha256: null };
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const root = document.createElement('section'); root.className = 'bf-batch';
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', parent: HTMLElement = root) => {
    const node = document.createElement(tag); node.textContent = text; parent.append(node); return node;
  };
  const act = (label: string, parent: HTMLElement, run: () => Promise<void>): HTMLButtonElement => {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = label;
    node.addEventListener('click', () => { void run().catch(fail); });
    parent.append(node); return node;
  };
  function fail(error: unknown): void { state.busy = null; state.error = String((error as Error).message ?? error); render(); }

  el('h3', say('批量导入', 'Batch import'));
  el('p', say('可以一次选多本，也可以选整个文件夹或一个 ZIP。先看清单再决定导入，导入完再决定要不要加进阅读计划。',
    'Pick several books, a whole folder, or one ZIP. Review the list first, then import, then decide whether to add them to the plan.')).className = 'batch-lead';

  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.multiple = true; fileInput.accept = '.txt,.md,.epub,.pdf'; fileInput.hidden = true;
  const folderInput = document.createElement('input');
  folderInput.type = 'file'; folderInput.multiple = true; folderInput.hidden = true;
  (folderInput as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
  const zipInput = document.createElement('input');
  zipInput.type = 'file'; zipInput.accept = '.zip'; zipInput.hidden = true;
  // One shared picker for "the file that was lost", so the flow is a normal file
  // dialog and never an upload of something the user did not choose.
  const reselectInput = document.createElement('input');
  reselectInput.type = 'file'; reselectInput.accept = '.txt,.md,.epub,.pdf'; reselectInput.hidden = true;
  reselectInput.dataset.role = 'batch-reselect';
  root.append(fileInput, folderInput, zipInput, reselectInput);

  const picker = el('div', ''); picker.className = 'batch-pickers';
  act(say('选择多本', 'Choose files'), picker, async () => { fileInput.value = ''; fileInput.click(); });
  act(say('选择文件夹', 'Choose folder'), picker, async () => { folderInput.value = ''; folderInput.click(); });
  act(say('导入 ZIP', 'Import ZIP'), picker, async () => { zipInput.value = ''; zipInput.click(); });

  const history = el('div', ''); history.className = 'batch-history';
  const body = el('div', ''); body.className = 'batch-body';
  const errorLine = el('p', ''); errorLine.className = 'batch-error';

  fileInput.addEventListener('change', () => { void startFiles('files', fileInput.files).catch(fail); });
  folderInput.addEventListener('change', () => { void startFiles('folder', folderInput.files).catch(fail); });
  zipInput.addEventListener('change', () => {
    const file = zipInput.files?.[0];
    if (!file) return;
    const pending = state.reselectZipId;
    state.reselectZipId = null;
    // A fresh pick has no pinned digest to honour; only a re-attach does.
    if (!pending) state.expectedZipSha256 = null;
    void (pending ? uploadZip(pending, file) : startZip(file)).catch(fail);
  });
  reselectInput.addEventListener('change', () => { const file = reselectInput.files?.[0]; if (file) void attachReselected(file).catch(fail); });

  const relativeName = (file: File): string => {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    return relative && relative.length ? relative : file.name;
  };

  function saySize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function uploadBytes(itemId: string, batchId: string, file: File): Promise<void> {
    const chunkBytes = 256 * 1024;
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      if (disposed || ctx.signal.aborted) throw new Error('已取消');
      const bytes = new Uint8Array(await file.slice(offset, offset + chunkBytes).arrayBuffer());
      let binary = '';
      for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      await ctx.invoke('import_batch_chunk', [batchId, itemId, offset, btoa(binary)]);
    }
  }

  async function startFiles(source: 'files' | 'folder', list: FileList | null): Promise<void> {
    if (!list?.length) return;
    state.error = null; state.busy = say('正在准备清单…', 'Preparing the list…'); render();
    const picked = [...list];
    const novels = picked.filter((file) => NOVEL.test(file.name));
    const skipped = picked.filter((file) => !NOVEL.test(file.name)).map(relativeName);
    if (!novels.length) throw new Error(say('这些文件都不是 .txt / .md / .epub / .pdf。', 'None of these files are .txt / .md / .epub / .pdf.'));
    const batch = await ctx.invoke<ImportBatch>('import_batch_create', [{ source }]);
    state.batch = batch;
    const added = await ctx.invoke<{ added: { name: string; id: string }[]; tooLarge: string[]; overBudget: string[] }>(
      'import_batch_add', [batch.id, novels.map((file) => ({ name: relativeName(file), size: file.size }))]);
    const offered = new Map(added.added.map((item) => [item.name, item.id]));
    let done = 0;
    for (const file of novels) {
      const itemId = offered.get(relativeName(file));
      if (!itemId) continue;
      state.busy = say(`正在上传 ${done + 1}/${offered.size}…`, `Uploading ${done + 1}/${offered.size}…`);
      render();
      await uploadBytes(itemId, batch.id, file);
      done += 1;
    }
    state.busy = null;
    const notes: string[] = [];
    if (skipped.length) notes.push(say(`已跳过 ${skipped.length} 个不支持的文件`, `${skipped.length} unsupported file(s) skipped`));
    if (added.tooLarge.length) notes.push(say(`${added.tooLarge.length} 个文件超过 100 MiB`, `${added.tooLarge.length} file(s) over 100 MiB`));
    if (added.overBudget.length) notes.push(say(`${added.overBudget.length} 个文件超出本批 1 GiB 预算`, `${added.overBudget.length} file(s) over the 1 GiB batch budget`));
    if (notes.length) state.error = notes.join('；');
    await refresh();
  }

  async function startZip(file: File): Promise<void> {
    if (!ZIP.test(file.name)) throw new Error(say('只支持 .zip 压缩包。', 'Only .zip archives are supported.'));
    state.error = null; state.busy = say('正在读取压缩包…', 'Reading the archive…'); render();
    const batch = await ctx.invoke<ImportBatch>('import_batch_create', [{ source: 'zip' }]);
    state.batch = batch;
    await uploadZip(batch.id, file);
  }

  /**
   * The digest is the identity the server checks its own hash against, and it is
   * established for EVERY archive size: small ones go through the native one-shot
   * digest, large ones stream 1 MiB slices through the incremental hasher so a
   * 512 MiB archive never sits in memory as a whole. A re-attached archive is
   * additionally checked against the digest the server pinned, so a wrong pick
   * fails before a single chunk is uploaded.
   */
  async function fileDigest(file: File): Promise<string | null> {
    if (file.size <= 64 * 1024 * 1024) {
      const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
      if (subtle) {
        try {
          const digest = await subtle.digest('SHA-256', await file.arrayBuffer());
          return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        } catch { /* fall through to the streaming hasher */ }
      }
    }
    return fileSha256Hex(file);
  }

  async function uploadZip(batchId: string, file: File): Promise<void> {
    state.busy = say('正在读取压缩包…', 'Reading the archive…'); render();
    const digest = await fileDigest(file);
    const expected = state.expectedZipSha256;
    if (digest && expected && digest !== expected) {
      throw new Error(say('选择的不是原来的那个压缩包（内容指纹不一致）；请重新选择原始文件，或新建一个批次。',
        'This is not the original archive (content digest differs); pick the original file again, or start a new batch.'));
    }
    state.busy = say('正在上传压缩包…', 'Uploading the archive…'); render();
    const info = await ctx.invoke<{ offset: number; chunkBytes: number }>('import_batch_zip_begin',
      [batchId, { name: file.name, size: file.size, ...(digest ? { sha256: digest } : {}) }]);
    for (let offset = 0; offset < file.size; offset += info.chunkBytes) {
      if (disposed || ctx.signal.aborted) throw new Error('已取消');
      const bytes = new Uint8Array(await file.slice(offset, offset + info.chunkBytes).arrayBuffer());
      let binary = '';
      for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      await ctx.invoke('import_batch_zip_chunk', [batchId, offset, btoa(binary)]);
      state.busy = say(`正在上传压缩包 ${Math.round((offset + bytes.length) / file.size * 100)}%`, `Uploading archive ${Math.round((offset + bytes.length) / file.size * 100)}%`);
      render();
    }
    state.expectedZipSha256 = null;
    const added = await ctx.invoke<{ unsupported: string[]; alreadyExtracted?: boolean }>('import_batch_zip_finish', [batchId]);
    state.busy = null;
    if (added.unsupported.length) state.error = say(`已跳过 ${added.unsupported.length} 个不支持的文件。`, `${added.unsupported.length} unsupported file(s) skipped.`);
    await refresh();
  }

  /** Re-attach the file a `needs_reselect` entry lost; the item keeps its place. */
  async function attachReselected(file: File): Promise<void> {
    const batchId = state.batch?.id, itemId = state.reselectItemId;
    if (!batchId || !itemId) throw new Error(say('请先选择要重新上传的书目。', 'Choose which book to re-attach first.'));
    state.busy = say('正在重新上传…', 'Re-attaching the file…'); render();
    await ctx.invoke('import_batch_reselect', [batchId, itemId, { size: file.size }]);
    await uploadBytes(itemId, batchId, file);
    state.reselectItemId = null;
    state.busy = null;
    await refresh();
  }

  async function refreshSummaries(): Promise<void> {
    state.summaries = await ctx.invoke<ImportBatchSummary[]>('import_batch_status', []);
    render();
  }

  async function refresh(): Promise<void> {
    if (!state.batch) { await refreshSummaries(); return; }
    state.view = await ctx.invoke<ImportBatchView>('import_batch_status', [state.batch.id]);
    state.batch = { ...state.batch, status: state.view.status };
    await refreshSummaries();
    schedulePoll();
  }

  async function openBatch(batchId: string): Promise<void> {
    state.batch = { id: batchId } as ImportBatch;
    await refresh();
  }

  function schedulePoll(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (disposed || !state.view) return;
    if (state.view.status !== 'running') return;
    timer = setTimeout(() => { void refresh().catch(fail); }, 800);
  }

  function renderHistory(): void {
    history.replaceChildren();
    if (!state.summaries.length) return;
    // Unfinished work first: after a restart this is the only way back in.
    const sorted = [...state.summaries].sort((a, b) => {
      const rank = (row: ImportBatchSummary) => row.status === 'running' || row.status === 'preview' ? 0 : 1;
      return rank(a) - rank(b) || b.updatedAt - a.updatedAt;
    });
    const unfinished = sorted.filter((row) => row.status !== 'completed' && row.status !== 'cancelled');
    el('h4', say(`导入记录（未完成 ${unfinished.length} 批）`, `Import history (${unfinished.length} unfinished)`), history).className = 'batch-history-title';
    for (const summary of sorted.slice(0, 8)) {
      const row = el('div', '', history); row.className = 'batch-history-row';
      const open = document.createElement('button'); open.type = 'button';
      open.textContent = `${summary.title} · ${BATCH_TEXT[summary.status]?.[0] ?? summary.status} · ${summary.completed}/${summary.total}`;
      open.addEventListener('click', () => { void openBatch(summary.id).catch(fail); });
      row.append(open);
      if (summary.needsReselect) el('small', say(`${summary.needsReselect} 本需重新选择文件`, `${summary.needsReselect} need the file again`), row).className = 'batch-warn';
      if (summary.status === 'running') el('small', say('继续在后台进行', 'continues in the background'), row);
      if (summary.status === 'completed' || summary.status === 'cancelled') {
        const forget = document.createElement('button'); forget.type = 'button'; forget.textContent = say('清理记录', 'Forget record');
        forget.addEventListener('click', () => {
          void ctx.invoke('import_batch_forget', [summary.id]).then(async () => {
            if (state.batch?.id === summary.id) { state.batch = null; state.view = null; }
            await refreshSummaries();
          }).catch(fail);
        });
        row.append(forget);
      }
    }
  }

  function render(): void {
    if (disposed) return;
    renderHistory();
    body.replaceChildren();
    errorLine.textContent = state.error ?? '';
    errorLine.hidden = !state.error;
    if (state.busy) { el('p', state.busy, body).className = 'batch-busy'; return; }
    const view = state.view;
    if (!view) return;

    const summary = el('p', '', body); summary.className = 'batch-summary';
    summary.textContent = say(
      `共 ${view.count} 本 · 预计占用 ${saySize(view.estimatedBytes)}` +
        (view.suspectedDuplicates ? ` · ${view.suspectedDuplicates} 本可能是已有版本` : '') +
        (view.unsupported.length ? ` · ${view.unsupported.length} 个不支持` : ''),
      `${view.count} books · about ${saySize(view.estimatedBytes)}` +
        (view.suspectedDuplicates ? ` · ${view.suspectedDuplicates} may already be on the shelf` : '') +
        (view.unsupported.length ? ` · ${view.unsupported.length} unsupported` : ''));

    if (view.zip) {
      const archive = el('div', '', body); archive.className = 'batch-archive';
      const zipState = view.zip.state;
      el('small', say(
        `压缩包：${view.zip.name} · ${saySize(view.zip.size)} · ` +
          (zipState === 'uploading' ? '正在上传' : zipState === 'needs_reselect' ? '上传已中断，需要重新选择' : zipState === 'ready' ? '已校验，等待解压' : '已解压'),
        `Archive: ${view.zip.name} · ${saySize(view.zip.size)} · ` +
          (zipState === 'uploading' ? 'uploading' : zipState === 'needs_reselect' ? 'interrupted, pick it again' : zipState === 'ready' ? 'verified, waiting for extraction' : 'extracted')), archive);
      if (view.zip.peakBytes) el('small', say(`解压峰值占用 ${saySize(view.zip.peakBytes)}`, `Peak disk use while extracting: ${saySize(view.zip.peakBytes)}`), archive).className = 'batch-note';
      if (zipState === 'extracted' && !view.count) {
        el('small', say('解压完成，但未发现可导入的书籍（可能是空压缩包、只有隐藏文件或全部是不支持的格式）。此批次不会自动加入阅读计划，可以清理这条记录。',
          'Extraction finished, but no importable books were found (empty archive, hidden files only, or all unsupported). Nothing joins the plan automatically; this record can be forgotten.'), archive).className = 'batch-note';
      }
      if (zipState === 'needs_reselect' && view.status === 'preview') {
        if (view.zip.reselectable === false) {
          el('small', say('此批次的中断上传没有可验证的内容指纹，无法确认重新选择的仍是同一个压缩包。请新建一个批次重新导入；本条记录保留为未完成状态，可随时清理。',
            'This interrupted upload has no verifiable digest, so a replacement cannot be proven to be the same archive. Start a new batch; this record stays unfinished and can be forgotten.'), archive).className = 'batch-warn';
        } else {
          el('small', say('重新选择同一个压缩包即可继续；大小或内容不同的包会被拒绝。',
            'Pick the same archive again to continue; a different size or content is refused.'), archive).className = 'batch-warn';
          act(say('重新选择 ZIP', 'Choose the ZIP again'), archive, async () => {
            const info = await ctx.invoke<{ sha256: string | null }>('import_batch_zip_reselect', [state.batch!.id]);
            state.reselectZipId = state.batch!.id;
            state.expectedZipSha256 = info.sha256;
            zipInput.value = '';
            zipInput.click();
          });
        }
      }
    }

    for (const group of view.groups) {
      const box = el('div', '', body); box.className = 'batch-group';
      const label = el('label', '', box);
      const check = document.createElement('input'); check.type = 'checkbox'; check.disabled = view.status !== 'completed';
      check.dataset.group = group.key; label.append(check);
      label.append(document.createTextNode(` ${group.name}（${group.itemIds.length} 本）`));
      if (group.mayBeSplitNovel) el('small', say('这些文件也可能是一本书拆开的多份；确认是同一系列再勾选。', 'These may be one novel split into parts; only tick this if they are really one series.'), box).className = 'batch-warn';
    }

    if (view.needsReselect) el('p', say(`${view.needsReselect} 本需要重新选择文件（上次导入被中断）。`, `${view.needsReselect} item(s) need the file picking again after an interruption.`), body).className = 'batch-warn';

    const list = el('div', '', body); list.className = 'batch-items';
    for (const item of view.items) {
      const row = el('div', '', list); row.className = 'batch-item';
      el('span', `《${item.title}》`, row);
      const status = STATUS_TEXT[item.status] ?? [item.status, item.status];
      const meta: string[] = [saySize(item.size), status[0]];
      if (item.duplicate === 'in_batch') meta.push(say('与本次另一本重名', 'same title as another pick'));
      else if (item.duplicate) meta.push(say('书架上已有同名同作者版本', 'same title and author already on the shelf'));
      el('small', meta.join(' · '), row);
      if (item.error) el('small', item.error, row).className = 'batch-error-inline';
      const actions = el('div', '', row); actions.className = 'batch-item-actions';
      const live = item.status === 'pending' || item.status === 'importing' || item.status === 'processing' || item.status === 'validating';
      if (live) {
        act(say('取消这本', 'Cancel this book'), actions, async () => {
          await ctx.invoke('import_batch_cancel_item', [state.batch!.id, item.id]);
          await refresh();
        });
      }
      if (item.status === 'failed' || item.status === 'cancelled') {
        act(say('重试这本', 'Retry'), actions, async () => {
          await ctx.invoke('import_batch_retry', [state.batch!.id, item.id]);
          await refresh();
        });
      }
      if (item.status === 'needs_reselect') {
        // A plain retry cannot help here: the bytes are gone, so the only honest
        // action is picking the same file again for this exact entry.
        act(say('重新选择文件', 'Choose the file again'), actions, async () => {
          state.reselectItemId = item.id;
          reselectInput.value = '';
          reselectInput.click();
        });
      }
    }

    const actions = el('div', '', body); actions.className = 'batch-actions';
    if (view.status === 'preview') {
      act(say('开始导入', 'Start import'), actions, async () => { await ctx.invoke('import_batch_start', [state.batch!.id]); await refresh(); });
      act(say('取消这批', 'Cancel this batch'), actions, async () => { await ctx.invoke('import_batch_cancel', [state.batch!.id]); await refresh(); });
    } else if (view.status === 'running') {
      act(say('取消这批', 'Cancel this batch'), actions, async () => { await ctx.invoke('import_batch_cancel', [state.batch!.id]); await refresh(); });
    } else {
      if (view.completed) {
        const toPlan = el('button', say('加入阅读计划', 'Add to the reading plan'), actions); toPlan.type = 'button';
        toPlan.addEventListener('click', () => {
          const groups = [...body.querySelectorAll<HTMLInputElement>('input[data-group]')].filter((node) => node.checked)
            .map((node) => ({ name: node.closest('label')?.textContent?.replace(/（.*$/u, '').trim() ?? '', key: node.dataset.group }))
            .map((entry) => ({ name: entry.name, bookKeys: view.groups.find((group) => group.key === entry.key)?.itemIds.flatMap((id) => {
              const item = view.items.find((row) => row.id === id); return item?.bookKey ? [item.bookKey] : []; }) ?? [] }))
            .filter((group) => group.bookKeys.length > 1);
          void ctx.invoke('import_batch_to_plan', [state.batch!.id, groups]).then(refresh).catch(fail);
        });
      }
      act(say('再导一批', 'Start another batch'), actions, async () => { state.batch = null; state.view = null; state.error = null; render(); });
    }
  }

  // Reopening the panel must never lose the way back into a half-finished batch.
  void refreshSummaries().catch(fail);

  return { root,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    } };
}
