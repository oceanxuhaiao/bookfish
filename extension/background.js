/** Protocol v2 worker. Only explicitly granted origins can receive authenticated requests. */
const MAX_CHUNK = 4 * 1024 * 1024;
const PAGE_LIMIT = 8 * 1024 * 1024;
const FILE_LIMIT = 100 * 1024 * 1024;
const consumer = crypto.randomUUID();
const DEFAULTS = { port: 47823, token: '', allowedOrigins: [] };
async function settings() { return chrome.storage.local.get(DEFAULTS); }
async function setState(patch) { const { state = {} } = await chrome.storage.local.get({ state: {} }); await chrome.storage.local.set({ state: { ...state, ...patch, at: Date.now() } }); }
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
function auth(token, job) { return { 'x-bookfish-token': token, 'x-bookfish-consumer': consumer, ...(job ? { 'x-bookfish-lease': job.lease } : {}) }; }
async function post(config, job, action, body, type = 'application/json', sequence) {
  return fetch(`http://127.0.0.1:${config.port}/bridge/jobs/${job.id}/${action}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { ...auth(config.token, job), 'content-type': type, ...(sequence === undefined ? {} : { 'x-bookfish-sequence': String(sequence) }) }, body,
  });
}
function transferError(code) { const error = new Error('Transfer failed'); error.code = code; return error; }
async function allowed(config, raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !config.allowedOrigins.includes(url.origin)) throw transferError('policy_blocked');
  if (!await chrome.permissions.contains({ origins: [`${url.protocol}//${url.hostname}/*`] })) throw transferError('permission_missing');
  return url;
}
async function handle(job, config) {
  if (!['page', 'file'].includes(job.kind) || typeof job.lease !== 'string' || !Number.isSafeInteger(job.maxBytes) || job.maxBytes <= 0 || !Number.isSafeInteger(job.leaseMs) || job.leaseMs < 100 || job.leaseMs > 120000) {
    await setState({ connected: false, error: '桥接协议不兼容，请同时更新扩展和 BookFish' }); return;
  }
  const controller = new AbortController();
  const revoke = () => controller.abort();
  const changed = (changes, area) => { if (area === 'local' && ['allowedOrigins', 'token', 'port'].some(key => changes[key])) revoke(); };
  chrome.storage.onChanged?.addListener(changed);
  chrome.permissions.onRemoved?.addListener(revoke);
  const timeout = setTimeout(() => controller.abort(), 120000);
  let heartbeatBusy = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy) return; heartbeatBusy = true;
    try { const sent = await post(config, job, 'heartbeat', '{}'); if (!sent.ok) controller.abort(); }
    catch { controller.abort(); } finally { heartbeatBusy = false; }
  }, Math.max(100, Math.min(5000, job.leaseMs / 3)));
  await setState({ job: job.kind });
  let reader, response;
  try {
    const url = await allowed(config, job.url);
    response = await fetch(url.href, { redirect: 'error', cache: 'no-store', credentials: url.protocol === 'https:' ? 'include' : 'omit', signal: controller.signal });
    if (!response.ok) throw transferError([401, 403].includes(response.status) ? 'permission_missing' : 'http_error');
    if (response.url !== url.href) throw transferError('policy_blocked');
    const max = Math.min(job.maxBytes, job.kind === 'page' ? PAGE_LIMIT : FILE_LIMIT);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > max) throw transferError('too_large');
    const contentType = response.headers.get('content-type') || undefined;
    if (job.kind === 'file' && contentType && !/^(text\/plain|text\/markdown|text\/x-markdown|application\/octet-stream|application\/x-download|binary\/octet-stream)(\s*;.*)?$/iu.test(contentType)) throw transferError('download_failed');
    reader = response.body?.getReader(); if (!reader) throw transferError('download_failed');
    let bytes = 0, sequence = 0; const pageParts = [];
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      if (controller.signal.aborted) throw transferError('cancelled');
      if (!value) continue; bytes += value.byteLength;
      if (bytes > max) throw transferError('too_large');
      if (job.kind === 'page') pageParts.push(value);
      else for (let offset = 0; offset < value.length; offset += MAX_CHUNK) {
        const sent = await post(config, job, 'chunk', value.subarray(offset, offset + MAX_CHUNK), 'application/octet-stream', sequence++);
        if (!sent.ok) throw transferError('cancelled');
      }
    }
    if (controller.signal.aborted) throw transferError('cancelled');
    if (job.kind === 'page') {
      const raw = new Uint8Array(bytes); let offset = 0; for (const part of pageParts) { raw.set(part, offset); offset += part.length; }
      const html = new TextDecoder().decode(raw);
      const sent = await post(config, job, 'page', JSON.stringify({ html, finalUrl: response.url })); if (!sent.ok) throw transferError('download_failed');
    } else {
      const sent = await post(config, job, 'done', JSON.stringify({ bytes, finalUrl: response.url, contentType })); if (!sent.ok) throw transferError('download_failed');
    }
  } catch (error) {
    const code = controller.signal.aborted ? 'cancelled' : typeof error.code === 'string' ? error.code : 'network';
    try { await post(config, job, 'fail', JSON.stringify({ code })); } catch { /* lease expires or bridge shuts down */ }
  } finally {
    chrome.storage.onChanged?.removeListener(changed); chrome.permissions.onRemoved?.removeListener(revoke);
    if (reader) await reader.cancel().catch(() => undefined); else await response?.body?.cancel().catch(() => undefined); controller.abort(); clearTimeout(timeout); clearInterval(heartbeat); await setState({ job: null });
  }
}
let looping = false;
async function pollLoop() {
  if (looping) return; looping = true;
  let pairedKey = '';
  try { for (;;) {
    const config = await settings();
    if (!config.token || !Number.isInteger(Number(config.port)) || config.port < 1024 || config.port > 65535) { await setState({ connected: false, error: '请先配置本机端口和配对令牌' }); await sleep(3000); continue; }
    try {
      const key = config.port + ':' + config.token;
      if (pairedKey !== key) {
        const hello = await fetch('http://127.0.0.1:' + config.port + '/bridge/hello', { headers: auth(config.token), redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!hello.ok || (await hello.json()).version !== 2) throw transferError('bridge_protocol');
        pairedKey = key;
      }
      const response = await fetch(`http://127.0.0.1:${config.port}/bridge/jobs`, { headers: auth(config.token), redirect: 'error', signal: AbortSignal.timeout(35000) });
      if (!response.ok) throw transferError('bridge_offline');
      const { job } = await response.json(); await setState({ connected: true, error: null, port: config.port }); if (job) await handle(job, config);
    } catch { pairedKey = ''; await setState({ connected: false, error: '桥接未响应，请检查端口、令牌和 BookFish 状态' }); await sleep(3000); }
  }} finally { looping = false; }
}
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('bookfish-poll', { periodInMinutes: 1 }); void pollLoop(); });
chrome.runtime.onStartup.addListener(() => { void pollLoop(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'bookfish-poll') void pollLoop(); });
chrome.runtime.onMessage.addListener((message, _sender, respond) => { if (message?.type === 'bookfish-wake') { void pollLoop(); respond({ ok: true }); } return false; });
void pollLoop();
