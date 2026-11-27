import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

type VoicePhase = 'disabled' | 'idle' | 'starting' | 'playing' | 'waiting_content' | 'paused' | 'error';
interface VoiceStatus {
  enabled: boolean; phase: VoicePhase; bookKey: string | null; title: string | null;
  segmentId: number | null; voicedUpTo: number | null; totalSegments: number | null;
  keyConfigured: boolean; error: string | null; detail: string | null;
}
interface VoiceView {
  config: { voiceOutputEnabled: boolean }; keyEnv: string; keyConfigured: boolean;
  keyMask: string | null; status: VoiceStatus;
}

const CSS = `
.bf-voice-card{display:grid;gap:8px;padding:14px 18px;border:1px solid #dfe6d8;border-radius:14px;background:#fbfcf8}
.bf-voice-card h3{margin:0;font-size:16px}
.bf-voice-card .bf-voice-status{margin:0;font-size:14px;color:#33413a}
.bf-voice-card .bf-voice-detail{margin:0;font-size:13px;color:#6e7b70;line-height:1.6}
.bf-voice-card .bf-voice-error{margin:0;font-size:13px;color:#a54332}
.bf-voice-card .bf-voice-actions{display:flex;gap:8px;flex-wrap:wrap}
.bf-voice-card button{padding:7px 14px;border:1px solid #d5dccd;border-radius:10px;background:#fff;color:#33413a;cursor:pointer}
.bf-voice-card button.primary{background:#3f7d5d;border-color:#3f7d5d;color:#fff}
.bf-voice-card button:disabled{opacity:.45;cursor:not-allowed}
.bf-voice-card .bf-voice-privacy{margin:0;font-size:12px;color:#738179;line-height:1.7}
.bf-voice-key{display:grid;gap:10px}
.bf-voice-key .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.bf-voice-key input{min-width:260px;padding:8px 10px;border:1px solid #d5dccd;border-radius:10px}
.bf-voice-key button{padding:8px 16px;border:1px solid #d5dccd;border-radius:10px;background:#fff;cursor:pointer}
.bf-voice-key button.primary{background:#3f7d5d;border-color:#3f7d5d;color:#fff}
.bf-voice-key .note{font-size:13px;color:#6e7b70;line-height:1.7;margin:0}
.bf-voice-key .error{font-size:13px;color:#a54332;margin:0}
`;

function ensureStyle(): void {
  if (typeof document === 'undefined' || document.getElementById('bf-voice-style')) return;
  const css = document.createElement('style'); css.id = 'bf-voice-style'; css.textContent = CSS; document.head.append(css);
}

function phaseLabel(status: VoiceStatus, en: boolean): string {
  if (!status.enabled) return en ? 'Off in settings' : '配置中未开启';
  switch (status.phase) {
    case 'playing': return en ? 'Playing' : '正在朗读';
    case 'waiting_content': return en ? 'Waiting for cached text' : '等待后续正文';
    case 'paused': return en ? 'Stopped' : '已停止';
    case 'error': return en ? 'Error' : '朗读出错';
    case 'starting': return en ? 'Starting' : '正在启动';
    default: return en ? 'Ready' : '待开始';
  }
}

export function mountVoiceCard(container: HTMLElement, ctx: WebUiPanelContext) {
  const en = ctx.language !== 'zh' && ctx.language !== 'zh-Hant';
  const say = (zh: string, english: string) => en ? english : zh;
  const root = document.createElement('section');
  root.className = 'bf-voice-card';
  root.setAttribute('aria-label', say('语音朗读', 'Read aloud'));
  container.append(root);
  ensureStyle();

  const title = document.createElement('h3'); title.textContent = say('语音朗读', 'Read aloud'); root.append(title);
  const statusLine = document.createElement('p'); statusLine.className = 'bf-voice-status'; statusLine.setAttribute('role', 'status'); statusLine.setAttribute('aria-live', 'polite'); root.append(statusLine);
  const detail = document.createElement('p'); detail.className = 'bf-voice-detail'; root.append(detail);
  const error = document.createElement('p'); error.className = 'bf-voice-error'; root.append(error);
  const actions = document.createElement('div'); actions.className = 'bf-voice-actions'; root.append(actions);
  const start = document.createElement('button'); start.type = 'button'; start.className = 'primary';
  const stop = document.createElement('button'); stop.type = 'button'; stop.textContent = say('停止朗读', 'Stop');
  actions.append(start, stop);
  const privacy = document.createElement('p'); privacy.className = 'bf-voice-privacy';
  privacy.textContent = say('使用小米 MiMo 云端语音合成：点击开始后，已缓存的小说正文会发送给该服务；不是本地离线朗读。关闭开关后立即恢复默读。',
    'Uses Xiaomi MiMo cloud TTS: after you click Start, cached novel text is sent to that service. This is not offline speech. Turning the setting off restores silent reading immediately.');
  root.append(privacy);

  let disposed = false;
  let busy = false;
  let current: VoiceView | undefined;

  function render(view: VoiceView) {
    current = view;
    const status = view.status;
    const total = status.totalSegments;
    const voiced = status.voicedUpTo;
    const currentSegment = status.segmentId;
    const parts = [phaseLabel(status, en)];
    if (status.title) parts.push(`《${status.title}》`);
    if (currentSegment !== null) parts.push(say(`第 ${currentSegment + 1} 段`, `segment ${currentSegment + 1}`));
    if (voiced !== null && total !== null) parts.push(say(`已完整播放至第 ${voiced + 1} 段，共 ${total} 段`, `fully voiced through ${voiced + 1} of ${total}`));
    statusLine.textContent = parts.join(' · ');
    detail.textContent = status.detail ?? '';
    const key = view.keyConfigured ? (view.keyMask ? say(`KEY 已保存（${view.keyMask}）`, `KEY saved (${view.keyMask})`) : say('KEY 已保存', 'KEY saved')) : say('尚未保存 MiMo 语音 KEY，请到配置页保存。', 'No MiMo KEY yet; save one in Settings.');
    error.textContent = status.error ?? '';
    error.hidden = !status.error;
    start.disabled = busy || !status.enabled || !view.keyConfigured || status.phase === 'playing';
    stop.disabled = busy || status.phase !== 'playing';
    start.textContent = status.phase === 'paused' || status.phase === 'waiting_content' || status.phase === 'error'
      ? say('继续朗读', 'Resume') : say('开始朗读', 'Start reading');
    if (!view.keyConfigured) detail.textContent = key;
    else if (!status.enabled) detail.textContent = say('语音朗读已在配置页关闭。开启后才会发送正文给云端。', 'Read aloud is off in Settings; no text is sent until you enable it.');
    else if (status.detail) detail.textContent = status.detail;
    else if (status.phase === 'idle') detail.textContent = say('语音已开启但尚未开始：大肥鱼暂时不会读取新的正文。点击“开始朗读”，或在配置中关闭语音恢复原有默读。', 'Read aloud is enabled but not started: she will not receive new text yet. Click Start, or turn the setting off to restore ordinary silent reading.');
  }

  async function refresh() {
    if (disposed || ctx.signal.aborted) return;
    try {
      const view = await ctx.invoke<VoiceView>('voice_status', []);
      if (disposed || ctx.signal.aborted) return;
      render(view);
    } catch (e) {
      if (disposed) return;
      error.hidden = false;
      error.textContent = say('无法读取语音状态：', 'Could not read voice status: ') + String(e).replace(/^(?:(?:WebUiInvokeError|Error):\s*)+/,'');
      start.disabled = true; stop.disabled = true;
    }
  }

  async function act(action: () => Promise<unknown>) {
    if (busy || disposed || ctx.signal.aborted) return;
    busy = true; start.disabled = true; stop.disabled = true;
    error.hidden = true;
    try {
      const view = await action() as VoiceView;
      if (disposed || ctx.signal.aborted) return;
      render(view);
    } catch (e) {
      if (disposed) return;
      error.hidden = false;
      error.textContent = String(e).replace(/^(?:(?:WebUiInvokeError|Error):\s*)+/,'');
    } finally {
      busy = false;
      if (!disposed && current) {
        start.disabled = !current.status.enabled || !current.keyConfigured || current.status.phase === 'playing';
        stop.disabled = current.status.phase !== 'playing';
      }
    }
  }

  start.addEventListener('click', () => { void act(() => ctx.invoke('voice_start', [])); }, { signal: ctx.signal });
  stop.addEventListener('click', () => { void act(() => ctx.invoke('voice_stop', [])); }, { signal: ctx.signal });
  ctx.interval(() => { if (!busy) void refresh(); }, 2000);
  void refresh();
  return { refresh, dispose() { disposed = true; } };
}

/** Key management rows for the Settings panel. The KEY itself is write-only. */
export function mountVoiceKeyCard(container: HTMLElement, ctx: WebUiPanelContext, say: (zh: string, en: string) => string) {
  ensureStyle();
  const root = document.createElement('div'); root.className = 'bf-voice-key'; container.append(root);
  const status = document.createElement('p'); status.className = 'note'; status.setAttribute('role', 'status'); root.append(status);
  const privacy = document.createElement('p'); privacy.className = 'note';
  privacy.textContent = say('云端合成：正文会发送给小米 MiMo 语音服务，不是本地离线朗读。KEY 只保存在本机部署 .env，配置、日志和模型工具都不会拿到明文。',
    'Cloud synthesis: text is sent to Xiaomi MiMo. The KEY stays in the local deployment .env and is never exposed to config, logs or model tools.');
  root.append(privacy);
  const row = document.createElement('div'); row.className = 'row'; root.append(row);
  const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'off'; input.maxLength = 300;
  input.placeholder = say('粘贴 MiMo 语音 KEY', 'Paste the MiMo KEY');
  const save = document.createElement('button'); save.type = 'button'; save.className = 'primary'; save.textContent = say('保存 KEY', 'Save KEY');
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = say('删除 KEY', 'Delete KEY');
  row.append(input, save, remove);
  const message = document.createElement('p'); message.className = 'note'; root.append(message);
  let disposed = false;
  let busy = false;

  function render(view: VoiceView) {
    status.textContent = view.keyConfigured
      ? say(`已保存，当前掩码：${view.keyMask ?? '••••'}`, `Saved; current mask: ${view.keyMask ?? '••••'}`)
      : say('尚未保存 KEY。', 'No KEY saved yet.');
    remove.disabled = busy || !view.keyConfigured;
    save.disabled = busy;
    input.placeholder = view.keyConfigured ? say('留空保持已保存的 KEY', 'Leave blank to keep the saved KEY') : say('粘贴 MiMo 语音 KEY', 'Paste the MiMo KEY');
  }
  async function refresh() {
    if (disposed || ctx.signal.aborted) return;
    try { const view = await ctx.invoke<VoiceView>('voice_status', []); if (!disposed) render(view); }
    catch (e) { if (!disposed) message.textContent = say('读取失败：', 'Could not load: ') + String(e); }
  }
  save.addEventListener('click', () => { void (async () => {
    if (busy || disposed) return;
    const key = input.value.trim();
    if (!key) { message.textContent = say('请先粘贴 KEY。', 'Paste a KEY first.'); return; }
    busy = true; save.disabled = true; remove.disabled = true;
    try {
      const view = await ctx.invoke<VoiceView>('voice_save_key', [key]);
      if (disposed || ctx.signal.aborted) return;
      input.value = ''; render(view);
      message.textContent = say('KEY 已保存。朗读会从下一次开始使用新 KEY。', 'KEY saved. A new session will use it.');
    } catch (e) {
      if (!disposed) { message.textContent = say('保存失败：', 'Save failed: ') + String(e); save.disabled = false; }
    } finally { busy = false; if (!disposed) void refresh(); }
  })(); }, { signal: ctx.signal });
  remove.addEventListener('click', () => { void (async () => {
    if (busy || disposed) return;
    if (!(await ctx.ui.confirm({ title: say('删除语音 KEY？', 'Delete the voice KEY?'), body: say('删除或更换 KEY 会结束当前朗读会话，并清空本次临时朗读水位。BookFish 已确认的阅读进度不受影响；重新开始后会从当前确认位置重新朗读。', 'Deleting or changing the KEY ends the current read-aloud session and clears its temporary voicing watermark. Confirmed reading progress is unchanged; a new session starts from the current confirmed position.') }))) return;
    busy = true; save.disabled = true; remove.disabled = true;
    try {
      const view = await ctx.invoke<VoiceView>('voice_clear_key', []);
      if (disposed || ctx.signal.aborted) return;
      render(view); message.textContent = say('已删除保存的 KEY。', 'Saved KEY removed.');
    } catch (e) {
      if (!disposed) { message.textContent = say('删除失败：', 'Delete failed: ') + String(e); remove.disabled = false; }
    } finally { busy = false; }
  })(); }, { signal: ctx.signal });
  void refresh();
  return { refresh, dispose() { disposed = true; } };
}