const portInput = document.getElementById('port');
const tokenInput = document.getElementById('token');
const saveButton = document.getElementById('save');
const statusBox = document.getElementById('status');

const show = (text, ok) => {
  statusBox.textContent = text;
  statusBox.className = ok ? 'ok' : 'bad';
};

async function load() {
  const stored = await chrome.storage.local.get({ port: 47823, token: '', state: {} });
  portInput.value = String(stored.port || 47823);
  tokenInput.value = String(stored.token || '');
  renderState(stored.state || {});
}

function renderState(state) {
  if (state.connected) show(`已连接（端口 ${state.port || portInput.value}）`, true);
  else if (state.error) show(state.error, false);
  else show('未连接：先在 BookFish 设置里开启“使用 Edge/Chrome 扩展”', false);
}

saveButton.addEventListener('click', async () => {
  // The settings card copies "port / token" as one string; accept it in either box.
  let port = Number(portInput.value) || 47823;
  let token = tokenInput.value.trim();
  const combined = token.match(/^(\d{2,5})\s*[\/\s]\s*(\S+)$/u);
  if (combined) { port = Number(combined[1]); token = combined[2]; }
  if (port < 1024 || port > 65535) { show('端口需在 1024—65535 之间', false); return; }
  if (!token) { show('请填入 BookFish 面板里的配对令牌', false); return; }
  await chrome.storage.local.set({ port, token, state: { connected: false, error: null, port, at: Date.now() } });
  show('已保存，正在连接…', true);
  chrome.runtime.sendMessage({ type: 'bookfish-wake' });
  setTimeout(load, 1500);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state) renderState(changes.state.newValue || {});
});

void load();

async function renderSources() {
  const { allowedOrigins = [] } = await chrome.storage.local.get({ allowedOrigins: [] });
  document.getElementById('sources').textContent = allowedOrigins.join('、') || '尚未授权公网来源';
}
function selectedOrigin() {
  const url = new URL(document.getElementById('source').value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid origin');
  return url.origin;
}
document.getElementById('grant').addEventListener('click', async () => {
  try {
    const origin = selectedOrigin();
    const granted = await chrome.permissions.request({ origins: [`${new URL(origin).protocol}//${new URL(origin).hostname}/*`] });
    if (!granted) { show('来源授权未获允许', false); return; }
    const { allowedOrigins = [] } = await chrome.storage.local.get({ allowedOrigins: [] });
    await chrome.storage.local.set({ allowedOrigins: [...new Set([...allowedOrigins, origin])] });
    await renderSources();
  } catch { show('请填写有效的 http/https 来源地址', false); }
});
document.getElementById('revoke').addEventListener('click', async () => {
  try {
    const origin = selectedOrigin(); const { allowedOrigins = [] } = await chrome.storage.local.get({ allowedOrigins: [] });
    await chrome.storage.local.set({ allowedOrigins: allowedOrigins.filter(item => item !== origin) });
    // Chrome host permissions ignore port specificity; retain the browser grant if another saved origin needs it.
    if (!allowedOrigins.some(item => item !== origin && new URL(item).hostname === new URL(origin).hostname && new URL(item).protocol === new URL(origin).protocol)) await chrome.permissions.remove({ origins: [`${new URL(origin).protocol}//${new URL(origin).hostname}/*`] });
    await renderSources();
  } catch { show('请填写需要撤销的来源', false); }
});
void renderSources();
