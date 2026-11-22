const portInput = document.getElementById('port');
const tokenInput = document.getElementById('token');
const saveButton = document.getElementById('save');
const statusBox = document.getElementById('status');
const BING_ORIGIN='https://cn.bing.com',BING_PATTERN='https://cn.bing.com/*';
let bingStatus;
document.getElementById('bing-toggle').disabled=true;

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
  if(area==='local'&&(changes.allowedOrigins||changes.bingSearchEnabled))void renderSources();
});

void load();

async function renderSources() {
  const { allowedOrigins = [],bingSearchEnabled=true } = await chrome.storage.local.get({ allowedOrigins: [],bingSearchEnabled:true });
  const permitted=await chrome.permissions.contains({origins:[BING_PATTERN]});
  bingStatus={enabled:bingSearchEnabled,permitted};document.getElementById('bing-toggle').disabled=false;
  document.getElementById('bing-state').textContent=bingSearchEnabled?(permitted?'Bing 搜索已启用（安装时授权，无需手动添加）':'Bing 搜索缺少浏览器站点访问权限，请允许访问 cn.bing.com。'):'Bing 搜索来源已停用。';
  document.getElementById('bing-toggle').textContent=bingSearchEnabled&&permitted?'停用 Bing 搜索来源':'启用 Bing 搜索来源';
  document.getElementById('sources').textContent = allowedOrigins.filter(item=>item!==BING_ORIGIN).join('、') || '其他资源来源尚未授权';
}
document.getElementById('bing-toggle').addEventListener('click',async()=>{
  if(!bingStatus)return;
  const {enabled,permitted}=bingStatus;
  try{
    if(enabled&&permitted)await chrome.storage.local.set({bingSearchEnabled:false});
    // Request directly from the click, before asynchronous storage reads consume the user gesture.
    else {if(!permitted&&!await chrome.permissions.request({origins:[BING_PATTERN]})){show('Bing 网站访问未获允许，请在浏览器扩展管理页检查权限。',false);return;}await chrome.storage.local.set({bingSearchEnabled:true});}
    await renderSources();
  }catch{show('无法更改 Bing 搜索来源，请重试。',false);}
});
chrome.permissions.onRemoved?.addListener(()=>{void renderSources();});
chrome.permissions.onAdded?.addListener(()=>{void renderSources();});
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
    await chrome.storage.local.set({ allowedOrigins: [...new Set([...allowedOrigins, origin])],...(origin===BING_ORIGIN?{bingSearchEnabled:true}:{}) });
    await renderSources();
  } catch { show('请填写有效的 http/https 来源地址', false); }
});
document.getElementById('revoke').addEventListener('click', async () => {
  try {
    const origin = selectedOrigin(); const { allowedOrigins = [] } = await chrome.storage.local.get({ allowedOrigins: [] });
    await chrome.storage.local.set({ allowedOrigins: allowedOrigins.filter(item => item !== origin),...(origin===BING_ORIGIN?{bingSearchEnabled:false}:{}) });
    // Chrome host permissions ignore port specificity; retain the browser grant if another saved origin needs it.
    if (origin!==BING_ORIGIN&&!allowedOrigins.some(item => item !== origin && new URL(item).hostname === new URL(origin).hostname && new URL(item).protocol === new URL(origin).protocol)) await chrome.permissions.remove({ origins: [`${new URL(origin).protocol}//${new URL(origin).hostname}/*`] });
    await renderSources();
  } catch { show('请填写需要撤销的来源', false); }
});
void renderSources();
