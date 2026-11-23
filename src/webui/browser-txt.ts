import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { TaskView } from '../txt-acquisition/types.ts';
import { openGuideDrawer } from './help.ts';
import type { BrowserSetupResult } from '../txt-acquisition/setup.ts';
import type { BookSearchHit } from '../txt-acquisition/book-search.ts';

export interface TxtSetup {
  networkEnabled: boolean; enabled: boolean; bridgeEnabled: boolean;
  controllerReady: boolean; transportConnected: boolean; browserReady: boolean;
  protectionMode?:'enhanced'|'standard'; standardAccepted?:boolean; isolationVerified?:boolean;
}

/** A user-facing client of the guarded acquisition path; never enables a guard. */
export function mountBrowserTxt(parent: HTMLElement, ctx: WebUiPanelContext, say: (zh: string, en: string) => string) {
  const root = document.createElement('section'); root.id = 'bf-browser-txt'; root.hidden = true; parent.append(root);
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, target: HTMLElement = root) {
    const node = document.createElement(tag); node.textContent = text; target.append(node); return node;
  }
  el('p', say('从你有权访问的资源页发现 TXT/Markdown，再选择文件入架。无需小说引擎；获取成功不等于读过。', 'Discover TXT/Markdown on an authorized resource page, then choose a file to import. No novel engine is needed; importing is never reading.'));
  const progress=el('section','');progress.className='card';progress.setAttribute('aria-label',say('当前配置状态','Current setup status'));
  const progressTitle=el('h3',say('正在检查配置…','Checking setup…'),progress);progressTitle.setAttribute('role','status');progressTitle.setAttribute('aria-live','polite');
  const nextSteps=el('ol','',progress);
  const verify=el('button',say('我已完成连接，重新检查','I have connected the extension; check again'),progress);verify.type='button';
  const connectionSettings=el('a',say('打开配置页，复制配对信息','Open settings and copy pairing details'),progress);connectionSettings.href='#/provider/world%3Abookfish/settings';connectionSettings.target='_blank';connectionSettings.rel='noopener';
  const location=el('button',say('查看扩展文件夹位置','Show extension folder'),progress);location.type='button';
  const locationText=el('p','',progress);locationText.style.overflowWrap='anywhere';
  const setup = el('details', ''); setup.open = true;
  el('summary', say('首次使用：配置浏览器辅助获取', 'First use: set up browser-assisted acquisition'), setup);
  const modeLabel=el('label',say('浏览器使用模式','Browser mode'),setup),mode=el('select','',modeLabel);
  mode.setAttribute('aria-label',say('浏览器使用模式','Browser mode'));
  for(const [value,label]of [['enhanced',say('增强保护（推荐）','Enhanced protection (recommended)')],['standard',say('普通模式（含模型自主浏览）','Standard mode (including autonomous browsing)')]]){const option=el('option',label,mode);option.value=value;}
  const standardRow=el('label','',setup);standardRow.hidden=true;
  const standardConsent=el('input','',standardRow);standardConsent.type='checkbox';standardConsent.dataset.standardConsent='true';
  standardRow.append(document.createTextNode(say('我允许手动及模型自主浏览使用普通模式，知悉日常浏览器可能携带登录态、无法保证完整网络隔离；仍建议安全组件和独立浏览器。','I allow manual and autonomous browsing in standard mode, including possible browser login-session use and weaker network isolation. Protection components and a separate browser remain recommended.')));
  const modeWarning=el('p','',setup);modeWarning.setAttribute('role','status');
  el('p', say('选择模式后点击“一键配置”。普通模式自动开启必要设置，扩展仍需安装、配对和来源授权；缺少联网权限时会单独提示。', 'Choose a mode, then run setup. Standard mode enables the required settings; extension installation, pairing and source permission are still required. Network permission is requested separately.'), setup);
  const configure = el('button', say('一键配置浏览器获取', 'Set up browser acquisition')); configure.type='button'; setup.append(configure);
  const steps = el('ol', '', setup); steps.setAttribute('aria-label', say('一键配置进度', 'Setup progress'));
  const consentRow = el('label', '', setup); consentRow.hidden = true;
  const consent = el('input', '', consentRow); consent.type='checkbox';
  consent.dataset.networkConsent='true';
  consentRow.append(document.createTextNode(say('允许大肥鱼联网（此权限也用于其他联网功能）', 'Allow Bookfish network access (also used by other network features)')));
  const advanced = el('details', '', setup); el('summary', say('高级配置与诊断（可选）', 'Advanced configuration and diagnostics (optional)'), advanced);
  const checks = el('ul', '', advanced);
  const note = el('p', '', setup); note.setAttribute('role', 'status');
  const settings = el('a', say('打开必要设置', 'Open required settings'), advanced);
  settings.href = '#/provider/world%3Abookfish/settings';
  const help = el('button', say('查看配置与使用说明', 'Setup and usage guide'), setup); help.type = 'button';
  const pairing=el('a',say('连接 Edge/Chrome 扩展','Connect the Edge/Chrome extension'),setup);pairing.href=settings.href;pairing.hidden=true;
  help.onclick = () => { void openGuideDrawer(ctx, say, 'browser-txt'); };
  const refresh = el('button', say('重新检查配置', 'Recheck settings'), advanced); refresh.type = 'button';
  const searchForm=el('form','');searchForm.className='novel-form';searchForm.dataset.bookSearch='true';
  const searchTitleLabel=el('label',say('书名（可只填作者）','Title (or search by author)'),searchForm),searchTitle=el('input','',searchTitleLabel);searchTitle.type='text';searchTitle.maxLength=200;
  const searchAuthorLabel=el('label',say('作者（可只填书名）','Author (or search by title)'),searchForm),searchAuthor=el('input','',searchAuthorLabel);searchAuthor.type='text';searchAuthor.maxLength=100;
  el('small',say('书名或作者至少填一个。通过 Bing 搜索 TXT 资源，搜索词会发送给 Bing；Bing 搜索来源已内置，安装新版扩展时授权，无需手动添加。搜索结果不代表已经验证作品身份或版权授权。','Enter a title or author. Queries are sent to Bing to search for TXT resources; Bing access is declared at extension installation; no manual source entry is needed. Results do not verify work identity or access rights.'),searchForm);
  const search=el('button',say('搜索书籍','Search books'),searchForm);search.type='submit';search.disabled=true;
  const searchResults=el('div','');
  const manual=el('details','');el('summary',say('已有资源页地址？手动发现（可选）','Already have a resource page? Manual discovery (optional)'),manual);
  const form = el('form', '',manual); form.className = 'novel-form';form.dataset.resource='true';
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
  let modeInitialized=false,standardAccepted=false;
  function renderMode(){standardRow.hidden=mode.value!=='standard'||standardAccepted;modeWarning.textContent=mode.value==='standard'?say('普通模式不要求安全组件或独立浏览器。确认后，模型自主浏览同样可用；这是较弱保障，来源权限和下载检查仍保留。','Standard mode needs no controller or isolated browser and also permits autonomous browsing after consent. It provides weaker protection; source permissions and download checks remain.'):say('增强保护需要安全组件和独立浏览器；推荐使用。','Enhanced protection requires a controller and isolated browser and is recommended.');}
  async function check() {
    ready = false; discover.disabled = search.disabled = true;
    const state = await ctx.invoke<TxtSetup>('txt_setup', []);
    if (ctx.signal.aborted) return false;
    if(!modeInitialized){mode.value=state.protectionMode??'enhanced';modeInitialized=true;}
    standardAccepted=state.standardAccepted===true;renderMode();
    checks.replaceChildren();
    for (const [ok, label] of [
      [state.networkEnabled, say('允许联网', 'Network access allowed')],
      [state.enabled, say('允许获取现成的 TXT 文件', 'TXT acquisition enabled')],
      [state.controllerReady, say('独立浏览器安全控制器就绪', 'Isolated browser protection controller ready')],
      [state.bridgeEnabled, say('Edge/Chrome 扩展桥接已开启', 'Edge/Chrome extension bridge enabled')],
      [state.transportConnected, say('扩展已连接', 'Extension connected')],
    ] as const) el('li', (ok ? '✓ ' : '○ ') + label, checks);
    ready = state.browserReady && state.networkEnabled && state.enabled && state.bridgeEnabled && (state.controllerReady || state.standardAccepted===true&&state.protectionMode==='standard') && state.transportConnected;
    nextSteps.replaceChildren();
    const localReady=state.networkEnabled&&state.enabled&&state.bridgeEnabled&&(state.controllerReady||state.standardAccepted===true&&state.protectionMode==='standard');
    progressTitle.textContent=ready?say('配置完成，可以开始获取','Setup complete. You can start acquiring files'):localReady?say('配置尚未完成：还差浏览器扩展连接','Setup incomplete: connect the browser extension'):say('配置尚未完成：请先完成下方模式与权限设置','Setup incomplete: choose a mode and confirm permissions below');
    const instructions=ready?[
      say('连接配置已通过。填写下方书名或作者，点击“搜索书籍”，选择作品后查看 TXT 候选并导入。无需先找资源页地址。','Connection checks passed. Search by title or author, choose a work, then find TXT candidates and import. No resource page URL is required.'),
      say('来源默认逐个授权；在扩展弹窗打开“允许所有网站”后，搜索和下载不再逐站询问。当前页面无法验证你已授权哪些网站。','Sources are granted per site by default; turn on "Allow all websites" in the extension popup to stop per-site prompts. This page cannot verify which sites are granted.'),
    ]:localReady?[
      say('本机设置已保存；一键配置还不会自动安装浏览器扩展。','Local settings are saved; setup does not yet install the browser extension automatically.'),
      say('点击“查看扩展文件夹位置”。在 Edge 地址栏输入 edge://extensions（Chrome 用 chrome://extensions），打开“开发人员模式”，选择“加载解压缩的扩展”，选中该文件夹。','Show the extension folder. Open edge://extensions (chrome://extensions in Chrome), enable developer mode and load that unpacked folder.'),
      say('打开配置页复制端口和令牌，在浏览器工具栏打开 BookFish 扩展，分别填入后点击“保存并连接”。不要把令牌发到聊天中。','Copy the port and token from settings into the BookFish extension popup, then save and connect. Do not share the token in chat.'),
      say('Bing 搜索来源已内置，安装时授权，无需手动填写。旧版扩展需更新并确认浏览器新增权限；不想逐站授权时，可在扩展弹窗打开“允许所有网站”。','Bing search access is built in and granted at installation. Update older extensions and confirm new browser permissions; to avoid per-site grants, turn on "Allow all websites" in the popup.'),
      say('回到这里点击“我已完成连接，重新检查”。此页每3秒检查连接；只有出现“配置完成，可以开始获取”且下方按钮可用，才表示连接配置完成。','Return here and recheck. Connection is checked every 3 seconds while this view is open. Setup is complete when the completion message appears and discovery is enabled.'),
    ]:[say('在下方选择使用模式并完成必要确认，然后点击“一键配置浏览器获取”；若提示还需操作，请继续按本清单完成。','Choose a mode and confirm the required permissions below, then run setup and follow the remaining steps here.')];
    for(const instruction of instructions)el('li',instruction,nextSteps);
    verify.hidden=ready||!localReady;connectionSettings.hidden=location.hidden=!localReady||ready;
    note.textContent = state.protectionMode==='standard'&&state.standardAccepted
      ? ready?say('普通模式已就绪；未验证强制隔离。','Standard mode is ready; enforced isolation has not been verified.'):say('普通模式已确认，请连接扩展并确认联网及获取权限。','Standard mode has been accepted. Connect the extension and check network/acquisition permissions.')
      : !state.controllerReady
      ? say('当前版本尚未接入正式安全控制器。可选择普通模式并确认后使用；增强保护暂不可用。', 'This version has no production protection controller. Choose and accept standard mode to continue; enhanced protection is unavailable.')
      : ready ? say('检查通过，可以发现资源页上的文件。', 'Checks passed. You can discover files on the resource page.') : say('配置尚未完成，请按说明完成未通过项后重新检查。', 'Setup is incomplete. Complete the missing checks and recheck.');
    if(!ready)setup.open=true; discover.disabled = search.disabled = !ready || busy || configuring; return ready;
  }
  async function run(action: () => Promise<void>) {
    try { await action(); } catch (error) { if (!ctx.signal.aborted) message.textContent = say('未完成：', 'Not completed: ') + String(error); }
  }
  refresh.onclick = () => { void run(async () => { await check(); }); };
  verify.onclick=refresh.onclick;
  location.onclick=()=>{void run(async()=>{const info=await ctx.invoke<{directory:string}>('txt_extension_location',[]);if(!ctx.signal.aborted)locationText.textContent=say('加载此文件夹：','Load this folder: ')+info.directory;});};
  let configuring = false, needsConsent = false,needsStandardConsent=false;
  consent.onchange = () => { configure.disabled = configuring || (needsConsent && !consent.checked) || (needsStandardConsent && !standardConsent.checked); };
  standardConsent.onchange=()=>{configure.disabled=configuring||(needsConsent&&!consent.checked)||(needsStandardConsent&&!standardConsent.checked);};
  mode.onchange=()=>{needsConsent=false;needsStandardConsent=false;consent.checked=false;standardConsent.checked=false;configure.disabled=configuring;renderMode();configure.textContent=say('应用模式并一键配置','Apply mode and set up');};
  configure.onclick = () => { if (configuring) return; configuring = true; configure.disabled = true; let completed = false;
    void run(async () => {
      note.textContent = say('正在检测并配置…', 'Checking and configuring…');
      progressTitle.textContent=note.textContent;
      steps.replaceChildren(); discover.disabled = true;
      const grantNetwork = needsConsent && consent.checked;
      consent.checked = false; // Consume this confirmation once; never reuse it after later revocation.
      const result = await ctx.invoke<BrowserSetupResult>('txt_setup_configure', [{ allowNetwork: grantNetwork,mode:mode.value,acceptStandard:standardConsent.checked }]);
      if(result.reason!=='network_consent'&&result.reason!=='standard_consent')standardConsent.checked=false;
      if (ctx.signal.aborted) return;
      await check(); steps.replaceChildren();
      if (result.state === 'ready' && !ready) { result.state='blocked'; result.reason='verification_failed'; result.steps[result.steps.length-1].state='blocked'; }
      const labels = { environment: say('检查运行环境', 'Check environment'), controller: say('安全组件', 'Protection component'), browser: say('独立浏览器', 'Isolated browser'), extension: say('扩展连接', 'Extension connection'), verification: say('验证并启用', 'Verify and enable') };
      const states = { done: say('已完成', 'Done'), pending: say('等待前一步', 'Waiting'), blocked: say('暂不能继续', 'Blocked'), action_required: say('需要你的确认', 'Needs your confirmation'),not_required:say('普通模式可选，推荐增强保护','Optional in standard mode; enhanced protection recommended') };
      for (const step of result.steps) el('li', labels[step.id] + '：' + states[step.state], steps);
      const reasons: Record<BrowserSetupResult['reason'], string> = {
        ready: say('配置完成，可以开始获取。', 'Setup complete. You can start acquiring files.'),
        unsupported_platform: say('当前一键配置仅支持 Windows，请先使用本地文件导入或小说引擎。', 'One-click setup currently supports Windows. Use local file import or the novel engine meanwhile.'),
        controller_unavailable: say('检测完成：当前版本尚未提供正式安全组件安装器，停在“安全组件”步骤。无需手动填写端口或令牌；浏览器获取暂不可用，可先使用本地文件导入或小说引擎。', 'Checks finished: this version does not include a production protection installer. Setup stopped at Protection component. No manual ports or tokens are needed. Use local file import or the novel engine meanwhile.'),
        pairing_unavailable: say('尚未建立可验证的独立浏览器连接，当前版本无法自动创建或配对。请使用受支持的安全组件安装流程后重试。', 'A verified isolated browser connection is missing. This version cannot automatically create or pair one. Complete a supported protection installation and retry.'),
        network_consent: say('继续需要允许大肥鱼联网，请确认后继续。', 'Confirm network access to continue.'),
        settings_unavailable: say('配置无法保存，请重试或查看高级配置。', 'Settings could not be saved. Retry or inspect advanced configuration.'),
        verification_failed: say('最终验证未通过，浏览器获取保持关闭。请重新检查配置。', 'Final verification failed. Browser acquisition remains unavailable; check setup again.'),
        standard_consent:say('请先确认普通模式适用于手动及模型自主浏览，且保障较弱。','Confirm standard mode for both manual and autonomous browsing, with weaker protection.'),
        extension_connection:say('普通模式已启用，不需要安全组件或独立浏览器。请安装并配对扩展、授予来源权限；连接后重新检查即可使用。','Standard mode is enabled without a controller or isolated browser. Install and pair the extension, grant source permissions, then recheck once connected.'),
        bridge_unavailable:say('浏览器连接准备失败，已尝试撤回本次设置，请检查端口或重试。','Browser connection setup failed. Changes were rolled back where possible; check the port or retry.'),
      };
      note.textContent = reasons[result.reason];
      if (result.state==='failed' && result.changed) note.textContent += say(' 部分设置可能已保存，请在高级配置中核对。', ' Some settings may have been saved; review them in advanced configuration.');
      needsConsent = result.reason === 'network_consent';needsStandardConsent=result.reason==='standard_consent';consentRow.hidden = !needsConsent;pairing.hidden=result.state!=='waiting_extension';
      configure.textContent = needsConsent ? say('同意并继续配置', 'Agree and continue setup') : result.state==='ready' ? say('重新验证配置', 'Verify setup again') : say('重新运行一键配置', 'Run setup again');
      setup.open = result.state !== 'ready';
      completed = true;
    }).finally(() => { configuring=false; configure.disabled=needsConsent&&!consent.checked||needsStandardConsent&&!standardConsent.checked; if (!completed) ready=false; search.disabled=discover.disabled=!ready||busy; if (!completed && !ctx.signal.aborted) { setup.open=true; progressTitle.textContent=say('配置未完成：连接检查失败，请重试','Setup incomplete: connection check failed; retry');note.textContent=say('配置未完成，请重试；也可查看高级配置中的检查结果。', 'Setup did not complete. Retry or inspect advanced diagnostics.'); } });
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
        finally { busy = false; discover.disabled = search.disabled = !ready; }
      }); };
    }
  }
  const cancel = el('button', say('取消当前 TXT 任务', 'Cancel current TXT task')); cancel.type = 'button'; cancel.hidden = true;
  searchForm.onsubmit=event=>{event.preventDefault();void run(async()=>{
    if(busy||configuring)return;const query={title:searchTitle.value.trim(),author:searchAuthor.value.trim()};
    if(!query.title&&!query.author){message.textContent=say('请至少填写书名或作者。','Enter a title or author.');return;}
    busy=true;search.disabled=discover.disabled=true;searchResults.replaceChildren();
    try{if(!await check())return;message.textContent=say('正在搜索书籍…最多等待30秒。','Searching for books… up to 30 seconds.');
      const found=await ctx.invoke<{hits:BookSearchHit[];blocked:boolean}>('txt_search',[query]);if(ctx.signal.aborted)return;
      message.textContent=found.blocked?say('搜索页要求验证，已停止；请在浏览器中正常完成验证后重试，或使用手动资源页入口。','The search page requires verification. Complete it normally in the browser and retry, or use manual discovery.'):found.hits.length?say('请选择作品或来源，再确认候选文件。搜索结果未验证书名、作者或全本完整性。','Choose a work or source, then check the file candidates. Search results do not verify work identity or completeness.'):say('没有找到可用搜索结果。可换关键词重试，或展开手动资源页入口。','No usable search results. Try other keywords or manual discovery.');
      for(const hit of found.hits){const card=el('article','',searchResults);card.className='novel-candidate';el('strong',hit.title,card);el('small',hit.host+' · '+hit.snippet,card);
        const label=el('label',say('检索目标书名（可修改）','Target title (editable)'),card),target=el('input','',label);target.type='text';target.maxLength=200;target.required=true;target.value=query.title||hit.suggestedTitle||hit.title.slice(0,200);
        el('small',say('打开此来源前，请在扩展中授权：','Before opening, grant this source in the extension: ')+new URL(hit.url).origin,card);
        const choose=el('button',say('确认作品，查找 TXT','Choose work and find TXT'),card);choose.type='button';
        choose.onclick=()=>{void run(async()=>{if(busy||configuring||!target.value.trim()||!target.reportValidity())return;busy=true;search.disabled=discover.disabled=true;
          try{if(!await check())return;message.textContent=say('正在查找该作品的 TXT 文件…','Finding TXT files for this work…');show(await ctx.invoke<TaskView>('txt_discover',[{title:target.value.trim(),author:query.author||undefined,url:hit.url}]));cancel.hidden=false;}
          finally{busy=false;search.disabled=discover.disabled=!ready;}
        });};
      }
    }finally{busy=false;search.disabled=discover.disabled=!ready;}
  });};
  cancel.onclick = () => { void run(async () => { if (current) show(await ctx.invoke<TaskView>('txt_cancel', [current.taskId])); }); };
  form.onsubmit = event => { event.preventDefault(); void run(async () => {
    if (busy || !form.reportValidity()) return;
    busy = true; discover.disabled = true;
    try { if (!await check()) return; message.textContent = say('正在浏览器中发现文件…', 'Discovering files in the browser…'); show(await ctx.invoke<TaskView>('txt_discover', [{ title: title.value.trim(), author: author.value.trim() || undefined, url: page.value.trim() }])); cancel.hidden = false; }
    finally { busy = false; discover.disabled = search.disabled = !ready; }
  }); };
  ctx.interval(async () => { if (!active || ctx.signal.aborted||configuring||busy||needsConsent||needsStandardConsent) return; await run(async () => { await check();if(current){const task = await ctx.invoke<TaskView>('txt_status', [current.taskId]); if (!busy) show(task);} }); }, 3000);
  return { activate(value: boolean, identity?: { title: string; author: string }) {
    active = value; root.hidden = !value;
    if (value) { if (!title.value && identity) title.value = identity.title; if (!author.value && identity) author.value = identity.author;if(identity&&!searchTitle.value)searchTitle.value=identity.title;if(identity&&!searchAuthor.value)searchAuthor.value=identity.author; void run(async () => { await check(); }); }
  } };
}
