import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { TaskView } from '../txt-acquisition/types.ts';
import { openGuideDrawer } from './help.ts';
import type { BrowserSetupResult } from '../txt-acquisition/setup.ts';

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
  el('p', say('点击“一键配置”检查环境、准备安全连接并验证可用性。端口和令牌由支持的配置流程处理；需要联网授权时会单独提示。', 'Use one-click setup to check the environment, prepare the protected connection and verify readiness. Supported setup handles ports and pairing; network permission is requested when needed.'), setup);
  const configure = el('button', say('一键配置浏览器获取', 'Set up browser acquisition')); configure.type='button'; setup.append(configure);
  const steps = el('ol', '', setup); steps.setAttribute('aria-label', say('一键配置进度', 'Setup progress'));
  const consentRow = el('label', '', setup); consentRow.hidden = true;
  const consent = el('input', '', consentRow); consent.type='checkbox';
  consentRow.append(document.createTextNode(say('允许大肥鱼联网（此权限也用于其他联网功能）', 'Allow Bookfish network access (also used by other network features)')));
  const advanced = el('details', '', setup); el('summary', say('高级配置与诊断（可选）', 'Advanced configuration and diagnostics (optional)'), advanced);
  const checks = el('ul', '', advanced);
  const note = el('p', '', setup); note.setAttribute('role', 'status');
  const settings = el('a', say('打开必要设置', 'Open required settings'), advanced);
  settings.href = '#/provider/world%3Abookfish/settings';
  const help = el('button', say('查看配置与使用说明', 'Setup and usage guide'), setup); help.type = 'button';
  help.onclick = () => { void openGuideDrawer(ctx, say, 'browser-txt'); };
  const refresh = el('button', say('重新检查配置', 'Recheck settings'), advanced); refresh.type = 'button';
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
    setup.open = !ready; discover.disabled = !ready || busy || configuring; return ready;
  }
  async function run(action: () => Promise<void>) {
    try { await action(); } catch (error) { if (!ctx.signal.aborted) message.textContent = say('未完成：', 'Not completed: ') + String(error); }
  }
  refresh.onclick = () => { void run(async () => { await check(); }); };
  let configuring = false, needsConsent = false;
  consent.onchange = () => { configure.disabled = configuring || (needsConsent && !consent.checked); };
  configure.onclick = () => { if (configuring) return; configuring = true; configure.disabled = true; let completed = false;
    void run(async () => {
      note.textContent = say('正在检测并配置…', 'Checking and configuring…');
      steps.replaceChildren(); discover.disabled = true;
      const grantNetwork = needsConsent && consent.checked;
      consent.checked = false; // Consume this confirmation once; never reuse it after later revocation.
      const result = await ctx.invoke<BrowserSetupResult>('txt_setup_configure', [{ allowNetwork: grantNetwork }]);
      if (ctx.signal.aborted) return;
      await check(); steps.replaceChildren();
      if (result.state === 'ready' && !ready) { result.state='blocked'; result.reason='verification_failed'; result.steps[result.steps.length-1].state='blocked'; }
      const labels = { environment: say('检查运行环境', 'Check environment'), controller: say('安全组件', 'Protection component'), browser: say('独立浏览器', 'Isolated browser'), extension: say('扩展连接', 'Extension connection'), verification: say('验证并启用', 'Verify and enable') };
      const states = { done: say('已完成', 'Done'), pending: say('等待前一步', 'Waiting'), blocked: say('暂不能继续', 'Blocked'), action_required: say('需要你的确认', 'Needs your confirmation') };
      for (const step of result.steps) el('li', labels[step.id] + '：' + states[step.state], steps);
      const reasons: Record<BrowserSetupResult['reason'], string> = {
        ready: say('配置完成，可以开始获取。', 'Setup complete. You can start acquiring files.'),
        unsupported_platform: say('当前一键配置仅支持 Windows，请先使用本地文件导入或小说引擎。', 'One-click setup currently supports Windows. Use local file import or the novel engine meanwhile.'),
        controller_unavailable: say('检测完成：当前版本尚未提供正式安全组件安装器，停在“安全组件”步骤。无需手动填写端口或令牌；浏览器获取暂不可用，可先使用本地文件导入或小说引擎。', 'Checks finished: this version does not include a production protection installer. Setup stopped at Protection component. No manual ports or tokens are needed. Use local file import or the novel engine meanwhile.'),
        pairing_unavailable: say('尚未建立可验证的独立浏览器连接，当前版本无法自动创建或配对。请使用受支持的安全组件安装流程后重试。', 'A verified isolated browser connection is missing. This version cannot automatically create or pair one. Complete a supported protection installation and retry.'),
        network_consent: say('安全连接已检查。继续需要允许大肥鱼联网，请确认后继续。', 'The protected connection has been checked. Confirm network access to continue.'),
        settings_unavailable: say('配置无法保存，请重试或查看高级配置。', 'Settings could not be saved. Retry or inspect advanced configuration.'),
        verification_failed: say('最终验证未通过，浏览器获取保持关闭。请重新检查配置。', 'Final verification failed. Browser acquisition remains unavailable; check setup again.'),
      };
      note.textContent = reasons[result.reason];
      if (result.state==='failed' && result.changed) note.textContent += say(' 部分设置可能已保存，请在高级配置中核对。', ' Some settings may have been saved; review them in advanced configuration.');
      needsConsent = result.state === 'consent_required'; consentRow.hidden = !needsConsent;
      configure.textContent = needsConsent ? say('同意并继续配置', 'Agree and continue setup') : result.state==='ready' ? say('重新验证配置', 'Verify setup again') : say('重新运行一键配置', 'Run setup again');
      setup.open = result.state !== 'ready';
      completed = true;
    }).finally(() => { configuring=false; configure.disabled=needsConsent&&!consent.checked; if (!completed) ready=false; discover.disabled=!ready||busy; if (!completed && !ctx.signal.aborted) { setup.open=true; note.textContent=say('配置未完成，请重试；也可查看高级配置中的检查结果。', 'Setup did not complete. Retry or inspect advanced diagnostics.'); } });
  };
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
