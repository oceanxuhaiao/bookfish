/**
 * Runtime installation card shared by the settings page and the shelf guide.
 *
 * Downloads and uploads are streamed by the World; this card only renders real
 * byte counts/percentages and never invents progress for extract/probe steps.
 */
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { RuntimeDownloadInfo, RuntimeStatusView, RuntimeUpdateInfo } from '../novel-runtime/types.ts';

interface RuntimeCardOptions {
  compact?: boolean;
  onReady?: () => void;
}

const PHASE_LABEL: Record<string, [string, string]> = {
  preparing: ['准备安装', 'Preparing'],
  downloading: ['下载运行时', 'Downloading runtime'],
  uploading: ['接收离线包', 'Receiving offline package'],
  verifying: ['校验摘要', 'Verifying digest'],
  extracting: ['安全解压', 'Extracting safely'],
  probing: ['启动自检', 'Startup self-check'],
  waiting_idle: ['等待在途任务结束', 'Waiting for running tasks'],
  activating: ['启用新运行时', 'Activating'],
  ready: ['安装完成', 'Ready'],
  failed: ['安装失败', 'Install failed'],
  cancelled: ['已取消', 'Cancelled'],
  interrupted: ['上次安装被中断', 'Last install was interrupted'],
  idle: ['未开始', 'Idle'],
};

const PHASE_DETAIL: Record<string, [string, string]> = {
  preparing: ['检查平台与安装目录，准备下载。', 'Checking the platform and install folder; preparing the download.'],
  downloading: ['正在下载固定版本的运行时压缩包；完成后自动校验。', 'Downloading the pinned runtime archive; verification starts when it finishes.'],
  uploading: ['正在接收你选择的离线运行时包。', 'Receiving the offline runtime ZIP you selected.'],
  verifying: ['核对压缩包摘要与文件清单，防止损坏或被替换。', 'Checking the archive digest and file list for damage or substitution.'],
  extracting: ['在临时目录安全解压，不覆盖当前版本。', 'Safely extracting into a staging folder; the current runtime stays untouched.'],
  probing: ['启动随包 Java 与引擎做自检，确认能运行。', 'Starting the bundled Java and engine for a self-check.'],
  waiting_idle: ['等待在途下载或阅读任务结束后再切换。', 'Waiting for running downloads or reads before switching.'],
  activating: ['原子切换到新版本；失败会保留旧版。', 'Atomically switching to the new runtime; the old one stays on failure.'],
  ready: ['安装完成，可以按书名或作者搜索。', 'Ready; title/author search is enabled.'],
  failed: ['安装失败，查看下面的错误原因。', 'Install failed; see the error below.'],
  cancelled: ['安装已取消，旧版保持不变。', 'Install cancelled; the previous runtime is unchanged.'],
  interrupted: ['上次安装被中断，可重试或导入离线包。', 'The last install was interrupted; retry or import an offline ZIP.'],
  idle: ['尚未开始安装。', 'Not started.'],
};
function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) binary += String.fromCharCode(...bytes.subarray(index, index + step));
  return btoa(binary);
}

function isActive(phase: string): boolean {
  return !['ready', 'failed', 'cancelled', 'interrupted', 'idle'].includes(phase);
}

export function mountRuntimeCard(container: HTMLElement, ctx: WebUiPanelContext, options: RuntimeCardOptions = {}): { refresh: () => Promise<void>; dispose: () => void } {
  const en = ctx.language !== 'zh' && ctx.language !== 'zh-Hant';
  const say = (zh: string, english: string): string => en ? english : zh;
  const root = document.createElement('section');
  root.className = 'card bf-runtime';
  const css = document.createElement('style');
  css.textContent = `
.bf-runtime{display:grid;gap:10px}.bf-runtime .runtime-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.bf-runtime h3{margin:0}.bf-runtime .runtime-badge{font-size:12px;border-radius:99px;padding:2px 10px;background:#e7ece2;color:#58705f;font-weight:600}.bf-runtime .runtime-badge[data-state=ok]{background:#dcefdc;color:#28643c}.bf-runtime .runtime-badge[data-state=busy]{background:#f4ecd7;color:#7c5c1c}.bf-runtime .runtime-badge[data-state=bad]{background:#f6e2dc;color:#8b3b2e}.bf-runtime .runtime-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:4px 18px;margin:0}.bf-runtime .runtime-meta div{font-size:13px;color:#5f7064}.bf-runtime .runtime-meta strong{color:#283d3a}.bf-runtime .runtime-actions{display:flex;gap:8px;flex-wrap:wrap}.bf-runtime progress{height:8px;margin:2px 0}.bf-runtime .runtime-error{border-left:3px solid #b2644c;background:#fbf0ec;padding:8px 12px;border-radius:6px;color:#7d3324;font-size:14px}.bf-runtime .runtime-note{font-size:13px;color:#6e7b70}.bf-runtime .runtime-phase-detail{color:#5f7064;font-size:13px;line-height:1.55}.bf-runtime .runtime-availability{margin:0;padding:9px 12px;border:1px solid #e2c98f;border-radius:7px;background:#fbf5df;color:#6d551c;font-size:13px;line-height:1.55}.bf-runtime .runtime-offline-link{color:#386c58;font-size:13px;text-decoration:underline;text-underline-offset:3px}.bf-runtime a.runtime-link{color:#386c58}
`;
  root.append(css);
  const head = document.createElement('div'); head.className = 'runtime-head'; root.append(head);
  const title = document.createElement('h3'); title.textContent = say('小说获取引擎', 'Novel fetch engine'); head.append(title);
  const badge = document.createElement('span'); badge.className = 'runtime-badge'; head.append(badge);
  const intro = document.createElement('p'); intro.style.margin = '0'; root.append(intro);
  const meta = document.createElement('div'); meta.className = 'runtime-meta'; root.append(meta);
  const progress = document.createElement('progress'); progress.hidden = true; progress.setAttribute('aria-label', say('安装进度', 'Install progress')); root.append(progress);
  const availability = document.createElement('p'); availability.className = 'runtime-availability'; availability.hidden = true; root.insertBefore(availability, progress);
  const offlineLink = document.createElement('a'); offlineLink.className = 'runtime-offline-link'; offlineLink.target = '_blank'; offlineLink.rel = 'noreferrer'; offlineLink.hidden = true; root.insertBefore(offlineLink, progress);
  const progressText = document.createElement('small'); progressText.hidden = true; root.append(progressText);
  const phaseDetail = document.createElement('small'); phaseDetail.className = 'runtime-phase-detail'; phaseDetail.hidden = true; phaseDetail.setAttribute('role', 'status'); phaseDetail.setAttribute('aria-live', 'polite'); root.append(phaseDetail);
  const errorBox = document.createElement('div'); errorBox.className = 'runtime-error'; errorBox.hidden = true; root.append(errorBox);
  const note = document.createElement('div'); note.className = 'runtime-note'; root.append(note);
  const actions = document.createElement('div'); actions.className = 'runtime-actions'; root.append(actions);

  let status: RuntimeStatusView | undefined;
  let lastUsable = false;
  let disposed = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let actionKey = '';
  let busyMessage = '';
  let updateInfo: RuntimeUpdateInfo | null = null;

  const invoke = async <T,>(method: string, args: unknown[] = []): Promise<T> => ctx.invoke<T>(method, args);

  function metaRow(label: string, value: string): HTMLElement {
    const row = document.createElement('div');
    const strong = document.createElement('strong'); strong.textContent = value;
    row.append(document.createTextNode(`${label}：`), strong);
    return row;
  }

  function addButton(label: string, primary: boolean, action: () => Promise<unknown>, disabled = false, starting?: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (primary) button.className = 'primary';
    button.disabled = disabled;
    button.addEventListener('click', () => { void run(action, starting); }, { signal: ctx.signal });
    return button;
  }

  async function run(action: () => Promise<unknown>, starting = say('正在处理…', 'Working…')): Promise<void> {
    if (disposed || ctx.signal.aborted) return;
    busyMessage = starting;
    note.textContent = busyMessage;
    try {
      await action();
      busyMessage = '';
      await refresh();
    } catch (error) {
      busyMessage = '';
      errorBox.hidden = false;
      errorBox.textContent = String(error).replace(/^(?:(?:WebUiInvokeError|Error):\s*)+/u, '');
      await refresh();
    } finally {
      // Any action can start a background install. Without this the card would
      // freeze at the first status snapshot (observed in the live host: the
      // archive finished while the UI still showed "0 B").
      if (!disposed && status?.install && isActive(status.install.phase)) startPolling();
    }
  }

  function renderActions(): void {
    const current = status!;
    const install = current.install;
    const phase = install?.phase ?? 'idle';
    const active = install !== null && isActive(phase);
    const key = [current.usable, current.installed, current.canRollback, current.canUninstall, current.online.available, phase, current.error?.code ?? '', updateInfo?.available?.runtimeId ?? '', options.compact ? 'c' : 'f'].join('|');
    if (key === actionKey) return;
    actionKey = key;
    actions.replaceChildren();
    if (active) {
      actions.append(addButton(say('取消安装', 'Cancel install'), false, async () => invoke('runtime_cancel')));
      return;
    }
    if (!current.usable) {
      const installButton = addButton(say('一键安装小说引擎', 'Install novel engine'), true, async () => invoke('runtime_install'), !current.online.available || !current.platform.supported, say('正在连接下载源并准备安装…', 'Contacting the download source and preparing the install…'));
      if (installButton.disabled) installButton.title = !current.platform.supported ? say('当前平台不支持一键安装；请用离线运行时包。', 'One-click install is unavailable on this platform; use an offline runtime ZIP.') : say('下载来源尚未配置；请用“导入离线运行时包”。', 'No download source is configured; use “Import offline runtime ZIP”.');
      actions.append(installButton);
      const file = document.createElement('input'); file.type = 'file'; file.accept = '.zip,application/zip'; file.hidden = true;
      file.addEventListener('change', () => { const selected = file.files?.[0]; if (selected) void run(() => importZip(selected)); }, { signal: ctx.signal });
      actions.append(file);
      const importButton = addButton(say('导入离线运行时包', 'Import offline runtime ZIP'), false, async () => { file.click(); });
      actions.append(importButton);
      if (current.online.available) actions.append(addButton(say('下载离线包', 'Download offline ZIP'), false, async () => { await downloadOffline(); }));
      if (current.installed) actions.append(addButton(say('修复安装', 'Repair install'), false, async () => { if (current.online.available) await invoke('runtime_install'); else file.click(); }));
      return;
    }
    if (!options.compact) {
      if (updateInfo?.available) actions.append(addButton(say(`升级到 ${updateInfo.available.runtimeVersion}`, `Upgrade to ${updateInfo.available.runtimeVersion}`), true, async () => { await invoke('runtime_install', [updateInfo!.available!.runtimeId]); updateInfo = null; }));
      actions.append(addButton(say('重新检测', 'Check again'), false, async () => { await invoke('runtime_probe'); await invoke('runtime_check_source'); }));
      actions.append(addButton(say('检查更新', 'Check for updates'), false, async () => { const result = await invoke<RuntimeUpdateInfo>('runtime_check_update'); updateInfo = result; note.textContent = result.reason ?? (result.available ? say(`发现新版本 ${result.available.runtimeVersion}`, `New runtime ${result.available.runtimeVersion} available`) : say('已是最新版本', 'Up to date')); actionKey = ''; renderActions(); }));
      const repairFile = document.createElement('input'); repairFile.type = 'file'; repairFile.accept = '.zip,application/zip'; repairFile.hidden = true;
      repairFile.addEventListener('change', () => { const selected = repairFile.files?.[0]; if (selected) void run(() => importZip(selected)); }, { signal: ctx.signal });
      actions.append(repairFile);
      actions.append(addButton(say('修复', 'Repair'), false, async () => { if (current.online.available) await invoke('runtime_install', [current.runtimeId]); else repairFile.click(); }));
      if (current.canRollback) actions.append(addButton(say('回退到上一版本', 'Roll back'), false, async () => { if (await ctx.ui.confirm({ title: say('回退运行时？', 'Roll back the runtime?'), body: say('只切换运行时，不改动书架、阅读进度和小说下载缓存。', 'Only the runtime changes; books, progress and download cache stay.') })) await invoke('runtime_rollback'); }));
      if (current.canUninstall) actions.append(addButton(say('卸载运行时', 'Uninstall runtime'), false, async () => {
        if (await ctx.ui.confirm({ title: say('卸载小说引擎运行时？', 'Uninstall the novel engine runtime?'), body: say('已加入书架的书籍和阅读进度会保留，之后可重新安装。', 'Shelved books and progress stay; you can reinstall later.'), danger: true })) {
          await invoke('runtime_uninstall');
          options.onReady?.();
        }
      }));
    }
  }

  async function importZip(file: File): Promise<void> {
    if (!/\.zip$/iu.test(file.name)) throw new Error(say('请选择 .zip 格式的离线运行时包', 'Choose an offline runtime .zip'));
    const begin = await invoke<{ id: string; chunkBytes: number }>('runtime_import_begin', [{ size: file.size, filename: file.name }]);
    await refresh();
    startPolling();
    let offset = 0;
    while (offset < file.size) {
      if (ctx.signal.aborted || disposed) return;
      const slice = new Uint8Array(await file.slice(offset, offset + begin.chunkBytes).arrayBuffer());
      const result = await invoke<{ offset: number }>('runtime_import_chunk', [begin.id, offset, toBase64(slice)]);
      offset = result.offset;
      progress.hidden = false; progress.max = file.size; progress.value = offset;
      progressText.hidden = false;
      progressText.textContent = `${say('上传离线包', 'Uploading offline package')} ${formatBytes(offset)} / ${formatBytes(file.size)}`;
    }
    await invoke('runtime_import_finish', [begin.id]);
    await refresh();
    startPolling();
  }

  async function downloadOffline(): Promise<void> {
    const info = await invoke<RuntimeDownloadInfo>('runtime_download_info');
    if (!info.available || !info.url) throw new Error(info.reason ?? say('下载地址尚未配置', 'Download URL is not configured'));
    const anchor = document.createElement('a');
    anchor.href = info.url; anchor.target = '_blank'; anchor.rel = 'noreferrer';
    anchor.download = info.fileName ?? '';
    anchor.click();
  }

  function apply(next: RuntimeStatusView): void {
    status = next;
    const install = next.install;
    const phase = install?.phase ?? 'idle';
    const active = install !== null && isActive(phase);
    const state = !next.platform.supported ? 'bad' : active ? 'busy' : next.usable ? 'ok' : next.installed ? 'bad' : 'plain';
    badge.dataset.state = state;
    badge.textContent = !next.platform.supported ? say('平台不支持', 'Unsupported platform')
      : active ? say('安装中', 'Installing')
        : next.usable ? say('可用', 'Ready') : next.installed ? say('需要修复', 'Needs repair') : say('未安装', 'Not installed');
    intro.textContent = !next.platform.supported
      ? say(`当前宿主为 ${next.platform.platform}-${next.platform.arch}，首发只支持 Windows x64。仍可继续使用文件导入。`, `This host is ${next.platform.platform}-${next.platform.arch}; the first release supports Windows x64 only. File import still works.`)
      : next.usable
        ? say('按书名或作者搜索与获取时使用这个本地引擎。它包含固定版本的 Java、引擎和书源规则，不依赖系统 Java。', 'Title/author search and fetching use this local engine. It bundles pinned Java, engine and rules; no system Java needed.')
        : say('用于按书名/作者搜索与获取。安装包较大，下载与安装只在你点击后进行；引擎就绪与书源网络可达分开判断。', 'Used for search and fetching by title/author. The download is large and only starts when you click. Engine readiness and source reachability are checked separately.');
    meta.replaceChildren();
    meta.append(metaRow(say('版本', 'Version'), next.runtimeVersion ?? '—'));
    meta.append(metaRow(say('引擎', 'Engine'), next.soNovelVersion ?? '—'));
    meta.append(metaRow(say('Java', 'Java'), next.javaVersion ?? '—'));
    meta.append(metaRow(say('平台', 'Platform'), `${next.platform.platform}-${next.platform.arch}`));
    meta.append(metaRow(say('下载大小', 'Download'), formatBytes(next.archiveBytes)));
    meta.append(metaRow(say('解压后', 'Unpacked'), formatBytes(next.payloadBytes)));
    meta.append(metaRow(say('上次自检', 'Last check'), next.health.checkedAt ? new Date(next.health.checkedAt).toLocaleString() : '—'));
    if (next.busyTasks) meta.append(metaRow(say('在途任务', 'Running tasks'), String(next.busyTasks)));
    const unsupported = !next.platform.supported;
    const unavailable = !next.usable && (unsupported || !next.online.available);
    availability.hidden = !unavailable;
    if (unavailable) availability.textContent = unsupported
      ? say(`一键安装不可用：当前平台 ${next.platform.platform}-${next.platform.arch} 不在首发支持范围。请用“导入离线运行时包”。`, `One-click install is unavailable on ${next.platform.platform}-${next.platform.arch}. Use “Import offline runtime ZIP”.`)
      : say(`一键安装不可用：${next.online.reason ?? '正式下载来源尚未配置'}。请用“导入离线运行时包”。`, `One-click install is unavailable: ${next.online.reason ?? 'no trusted download source is configured'}. Use “Import offline runtime ZIP”.`);
    const offlineUrl = next.online.offlineUrl ?? null;
    offlineLink.hidden = !offlineUrl;
    if (offlineUrl) {
      offlineLink.href = offlineUrl;
      offlineLink.title = offlineUrl;
      offlineLink.textContent = say(`下载离线运行时包（Windows x64，${formatBytes(next.online.offlineSizeBytes)}）`, `Download offline runtime ZIP (Windows x64, ${formatBytes(next.online.offlineSizeBytes)})`);
    }
    if (install && phase !== 'ready') {
      const labels = PHASE_LABEL[phase] ?? [phase, phase];
      const detail = PHASE_DETAIL[phase] ?? ['正在处理安装步骤。', 'Processing an install step.'];
      progress.hidden = false;
      progressText.hidden = false;
      phaseDetail.hidden = false;
      if (install.percent !== null) { progress.max = 100; progress.value = install.percent; }
      else { progress.removeAttribute('value'); }
      const speed = install.speedBytesPerSecond ? ` · ${formatBytes(install.speedBytesPerSecond)}/s` : '';
      const bytes = install.bytesTotal ? ` · ${formatBytes(install.bytesReceived)} / ${formatBytes(install.bytesTotal)}` : '';
      progressText.textContent = `${say(labels[0], labels[1])}${bytes}${speed}`;
      phaseDetail.textContent = say(detail[0], detail[1]);
    } else {
      progress.hidden = true; progressText.hidden = true; phaseDetail.hidden = true;
    }
    errorBox.hidden = !next.error;
    if (next.error) errorBox.textContent = next.error.message;
    const notes: string[] = [];
    if (next.note) notes.push(next.note);
    if (next.usable && next.health.message) notes.push(next.health.message);
    if (!next.online.available && next.online.reason) notes.push(next.online.reason);
    if (next.source === 'legacy') notes.push(say('当前沿用旧版目录；升级会安装到受管版本目录。', 'Currently using the legacy directory; upgrading installs a managed version.'));
    note.textContent = busyMessage || notes.join(' · ');
    renderActions();
    if (next.usable && !lastUsable) options.onReady?.();
    lastUsable = next.usable;
  }

  async function refresh(): Promise<void> {
    if (disposed || ctx.signal.aborted) return;
    try {
      const next = await invoke<RuntimeStatusView>('runtime_status');
      if (disposed || ctx.signal.aborted) return;
      apply(next);
    } catch (error) {
      errorBox.hidden = false;
      errorBox.textContent = String(error).replace(/^(?:(?:WebUiInvokeError|Error):\s*)+/u, '');
    }
  }

  function startPolling(): void {
    if (pollTimer) clearTimeout(pollTimer);
    const tick = async (): Promise<void> => {
      if (disposed || ctx.signal.aborted) return;
      await refresh();
      if (disposed || ctx.signal.aborted || !status) return;
      const install = status.install;
      const active = install !== null && isActive(install.phase);
      if (active) pollTimer = setTimeout(() => { void tick(); }, 1100);
    };
    pollTimer = setTimeout(() => { void tick(); }, 700);
  }

  container.append(root);
  void refresh().then(() => { if (status?.install) startPolling(); });
  // A second, cheap refresh when the user reopens the page after an install
  // that happened in the background.
  return {
    refresh,
    dispose() { disposed = true; if (pollTimer) clearTimeout(pollTimer); pollTimer = undefined; },
  };
}
