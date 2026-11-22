import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { TaskView } from '../txt-acquisition/types.ts';
import { openGuideDrawer } from './help.ts';

export interface TxtSetup {
  networkEnabled: boolean; enabled: boolean; bridgeEnabled: boolean;
  controllerReady: boolean; transportConnected: boolean; browserReady: boolean;
}

/** A user-facing client of the guarded acquisition path; never enables a guard. */
export function mountBrowserTxt(parent: HTMLElement, ctx: WebUiPanelContext, say: (zh: string, en: string) => string) {
  const root = document.createElement('section'); root.id = 'bf-browser-txt'; root.hidden = true; parent.append(root);
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, target: HTMLElement = root) {
    const node = document.createElement(tag); node.textContent = text; target.append(node); return node;
  }
  el('p', say('从你有权访问的资源页发现 TXT/Markdown，再选择文件入架。无需小说引擎；获取成功不等于读过。', 'Discover TXT/Markdown on an authorized resource page, then choose a file to import. No novel engine is needed; importing is never reading.'));
  const setup = el('details', ''); setup.open = true;
  el('summary', say('首次使用：配置浏览器辅助获取', 'First use: set up browser-assisted acquisition'), setup);
  el('p', say('先准备受保护的独立 Edge/Chrome，再配置扩展连接。请勿使用日常浏览器或个人登录态。只有下列检查全部通过才可开始。', 'Prepare a protected isolated Edge/Chrome instance and connect its extension. Do not use your everyday browser or personal login session. Every check below must pass before starting.'), setup);
  const checks = el('ul', '', setup);
  const note = el('p', '', setup); note.setAttribute('role', 'status');
  const settings = el('a', say('打开必要设置', 'Open required settings'), setup);
  settings.href = '#/provider/world%3Abookfish/settings';
  el('span', ' · ', setup);
  const help = el('button', say('查看配置与使用说明', 'Setup and usage guide'), setup); help.type = 'button';
  help.onclick = () => { void openGuideDrawer(ctx, say, 'browser-txt'); };
  const refresh = el('button', say('重新检查配置', 'Recheck settings'), setup); refresh.type = 'button';
  const form = el('form', ''); form.className = 'novel-form';
  function input(label: string, type: string, max: number) {
    const row = el('label', label, form), node = el('input', '', row); node.type = type; node.maxLength = max; return node;
  }
  const title = input(say('要获取的书名', 'Book title to acquire'), 'text', 200); title.required = true;
  const author = input(say('作者（选填）', 'Author (optional)'), 'text', 100);
  const page = input(say('有权访问的资源页地址', 'Authorized resource page URL'), 'url', 2000); page.required = true;
  el('small', say('只知道作者时，先找到具体作品的资源页并补全书名。这里不会自动搜索全网、登录或绕过访问限制。', 'If you only know the author, first choose a work on an authorized resource page and enter its title. This route does not automatically search the web, log in, or bypass access restrictions.'), form);
  const discover = el('button', say('发现 TXT 文件', 'Discover TXT files'), form); discover.type = 'submit'; discover.disabled = true;
  const message = el('p', ''); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const results = el('div', ''); let ready = false, busy = false, active = false, current: TaskView | undefined;
  async function check() {
    ready = false; discover.disabled = true;
    const state = await ctx.invoke<TxtSetup>('txt_setup', []);
    if (ctx.signal.aborted) return false;
    checks.replaceChildren();
    for (const [ok, label] of [
      [state.networkEnabled, say('允许联网', 'Network access allowed')],
      [state.enabled, say('允许获取现成的 TXT 文件', 'TXT acquisition enabled')],
      [state.controllerReady, say('独立浏览器安全控制器就绪', 'Isolated browser protection controller ready')],
      [state.bridgeEnabled, say('Edge/Chrome 扩展桥接已开启', 'Edge/Chrome extension bridge enabled')],
      [state.transportConnected, say('扩展已连接', 'Extension connected')],
    ] as const) el('li', (ok ? '✓ ' : '○ ') + label, checks);
    ready = state.browserReady && state.networkEnabled && state.enabled && state.bridgeEnabled && state.controllerReady && state.transportConnected;
    note.textContent = !state.controllerReady
      ? say('当前版本尚未接入正式安全控制器，浏览器获取暂不可用。仅开启开关或安装扩展不能完成配置；可先使用本地文件导入或小说引擎。', 'This version has no production protection controller, so browser acquisition is unavailable. Switches or extension installation alone cannot complete setup. Use local file import or the novel engine meanwhile.')
      : ready ? say('检查通过，可以发现资源页上的文件。', 'Checks passed. You can discover files on the resource page.') : say('配置尚未完成，请按说明完成未通过项后重新检查。', 'Setup is incomplete. Complete the missing checks and recheck.');
    setup.open = !ready; discover.disabled = !ready || busy; return ready;
  }
  async function run(action: () => Promise<void>) {
    try { await action(); } catch (error) { if (!ctx.signal.aborted) message.textContent = say('未完成：', 'Not completed: ') + String(error); }
  }
  refresh.onclick = () => { void run(async () => { await check(); }); };
  function show(task: TaskView) {
    if (ctx.signal.aborted) return;
    current = task; results.replaceChildren();
    const complete = task.status === 'completed' || task.status === 'completed_with_warning';
    message.textContent = complete
      ? say('已入架；阅读进度不会因导入而增加。', 'Added to the shelf; importing does not advance reading progress.')
      : task.failure?.message ?? task.rejection?.message ?? say('文件发现完成，请确认实际作品身份再导入。', 'Discovery finished. Check the actual work identity before importing.');
    if (task.file) el('p', `${task.file.filename} · ${task.file.bytes} bytes`, results);
    if (task.quality) {
      el('p', say('质量报告：', 'Quality report: ') + ({ clean: say('正文可读', 'Readable'), warning: say('存在瑕疵', 'Has warnings'), partial: say('仅部分可读，不能视为全本', 'Partially readable; not a complete book') }[task.quality.quality]), results);
      for (const issue of [...task.quality.repairs, ...task.quality.warnings]) el('small', issue.message, results);
    }
    if (task.requiresRediscovery) el('p', say('资源链接已失效，请重新发现文件。保留的原件不会因此删除。', 'Rediscover the resource links. Retained originals are preserved.'), results);
    for (const candidate of task.candidates ?? []) {
      const card = el('article', '', results); card.className = 'novel-candidate';
      el('strong', candidate.title || candidate.filename, card);
      el('small', (candidate.author || say('作者未知', 'Unknown author')) + ' · ' + candidate.host, card);
      const use = el('button', say('导入此 TXT 文件', 'Import this TXT file'), card); use.type = 'button'; use.disabled = !candidate.available || task.status !== 'candidate_ready';
      use.onclick = () => { void run(async () => {
        if (busy) return;
        busy = true; discover.disabled = true; use.disabled = true;
        try { if (!await check()) return; message.textContent = say('正在获取并校验文件…', 'Acquiring and checking the file…'); const imported = await ctx.invoke<{ task: TaskView }>('txt_import', [{ taskId: task.taskId, candidateId: candidate.candidateId }]); show(imported.task); await ctx.refresh(); }
        finally { busy = false; discover.disabled = !ready; }
      }); };
    }
  }
  const cancel = el('button', say('取消当前 TXT 任务', 'Cancel current TXT task')); cancel.type = 'button'; cancel.hidden = true;
  cancel.onclick = () => { void run(async () => { if (current) show(await ctx.invoke<TaskView>('txt_cancel', [current.taskId])); }); };
  form.onsubmit = event => { event.preventDefault(); void run(async () => {
    if (busy || !form.reportValidity()) return;
    busy = true; discover.disabled = true;
    try { if (!await check()) return; message.textContent = say('正在独立浏览器中发现文件…', 'Discovering files in the isolated browser…'); show(await ctx.invoke<TaskView>('txt_discover', [{ title: title.value.trim(), author: author.value.trim() || undefined, url: page.value.trim() }])); cancel.hidden = false; }
    finally { busy = false; discover.disabled = !ready; }
  }); };
  ctx.interval(async () => { if (!active || !current || ctx.signal.aborted) return; await run(async () => { const task = await ctx.invoke<TaskView>('txt_status', [current!.taskId]); if (!busy) show(task); }); }, 3000);
  return { activate(value: boolean, identity?: { title: string; author: string }) {
    active = value; root.hidden = !value;
    if (value) { if (!title.value && identity) title.value = identity.title; if (!author.value && identity) author.value = identity.author; void run(async () => { await check(); }); }
  } };
}
