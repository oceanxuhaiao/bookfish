/**
 * BookFish browser bridge worker.
 *
 * The world (BookFish) runs a loopback HTTP server. This worker polls it for jobs,
 * performs them with the browser's own cookies and TLS stack, and hands back raw
 * bytes. Nothing here decides whether a file is a book: the world validates,
 * repairs and imports. We never touch the user's tabs.
 */

const MAX_CHUNK = 4 * 1024 * 1024;
const POLL_TIMEOUT_MS = 35_000;
const RETRY_DELAY_MS = 3_000;

const DEFAULTS = { port: 47823, token: '' };

async function settings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { port: Number(stored.port) || DEFAULTS.port, token: String(stored.token || '') };
}

async function setState(patch) {
  const state = (await chrome.storage.local.get({ state: {} })).state || {};
  await chrome.storage.local.set({ state: { ...state, ...patch, at: Date.now() } });
}

function base(port) {
  return `http://127.0.0.1:${port}`;
}

function headers(token, extra) {
  return { ...(extra || {}), 'x-bookfish-token': token };
}

function sleeping(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function post(port, token, path, body, contentType) {
  const response = await fetch(`${base(port)}${path}`, {
    method: 'POST',
    headers: headers(token, contentType ? { 'content-type': contentType } : {}),
    body,
  });
  return response;
}

function failBody(code, message) {
  return JSON.stringify({ code, message });
}

/** One page job: fetch the resource page with the user's own session. */
async function runPage(job, port, token) {
  let response;
  try {
    response = await fetch(job.url, { credentials: 'include', redirect: 'follow', cache: 'no-store' });
  } catch (error) {
    await post(port, token, `/bridge/jobs/${job.id}/fail`, failBody('network', `Could not reach ${new URL(job.url).host}`), 'application/json');
    return;
  }
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'permission_missing' : 'http_error';
    await post(port, token, `/bridge/jobs/${job.id}/fail`, failBody(code, `The page answered ${response.status}`), 'application/json');
    return;
  }
  const html = await response.text();
  await post(port, token, `/bridge/jobs/${job.id}/page`, JSON.stringify({ html, finalUrl: response.url }), 'application/json');
}

/** One file job: stream raw bytes; the world decodes them, never this worker. */
async function runFile(job, port, token, signal) {
  let response;
  try {
    response = await fetch(job.url, { credentials: 'include', redirect: 'follow', cache: 'no-store', signal });
  } catch (error) {
    await post(port, token, `/bridge/jobs/${job.id}/fail`, failBody('network', 'The download address did not answer'), 'application/json');
    return;
  }
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'permission_missing' : 'http_error';
    await post(port, token, `/bridge/jobs/${job.id}/fail`, failBody(code, `The file answered ${response.status}`), 'application/json');
    return;
  }
  const contentType = response.headers.get('content-type') || undefined;
  const reader = response.body?.getReader();
  if (!reader) {
    await post(port, token, `/bridge/jobs/${job.id}/fail`, failBody('http_error', 'The response had no body'), 'application/json');
    return;
  }
  let pending = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (value && value.length) {
      const merged = new Uint8Array(pending.length + value.length);
      merged.set(pending, 0);
      merged.set(value, pending.length);
      pending = merged;
    }
    while (pending.length >= MAX_CHUNK) {
      const slice = pending.slice(0, MAX_CHUNK);
      pending = pending.slice(MAX_CHUNK);
      const sent = await post(port, token, `/bridge/jobs/${job.id}/chunk`, slice, 'application/octet-stream');
      if (!sent.ok) {
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
    if (done) break;
  }
  if (pending.length) {
    const sent = await post(port, token, `/bridge/jobs/${job.id}/chunk`, pending, 'application/octet-stream');
    if (!sent.ok) return;
  }
  await post(port, token, `/bridge/jobs/${job.id}/done`, JSON.stringify({ finalUrl: response.url, contentType }), 'application/json');
}

async function handle(job, port, token) {
  await setState({ job: job.kind });
  const controller = new AbortController();
  try {
    if (job.kind === 'page') await runPage(job, port, token);
    else if (job.kind === 'file') await runFile(job, port, token, controller.signal);
  } finally {
    controller.abort();
    await setState({ job: null });
  }
}

let looping = false;

async function pollLoop() {
  if (looping) return;
  looping = true;
  try {
    for (;;) {
      const { port, token } = await settings();
      if (!token) {
        await setState({ connected: false, error: 'Paste the pairing token from BookFish settings' });
        await sleeping(5_000);
        continue;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
      try {
        const response = await fetch(`${base(port)}/bridge/jobs`, { headers: headers(token), signal: controller.signal });
        if (response.status === 401) {
          await setState({ connected: false, error: 'The pairing token does not match' });
          await sleeping(5_000);
          continue;
        }
        if (!response.ok) {
          await setState({ connected: false, error: `Bridge answered ${response.status}` });
          await sleeping(RETRY_DELAY_MS);
          continue;
        }
        const body = await response.json();
        await setState({ connected: true, error: null, port });
        if (body && body.job) await handle(body.job, port, token);
      } catch (error) {
        await setState({ connected: false, error: controller.signal.aborted ? 'No answer; is BookFish running?' : String(error && error.message || error) });
        await sleeping(RETRY_DELAY_MS);
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    looping = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('bookfish-poll', { periodInMinutes: 1 });
  void pollLoop();
});

chrome.runtime.onStartup.addListener(() => {
  void pollLoop();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bookfish-poll') void pollLoop();
});

// The popup nudges the loop after the token changes.
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message && message.type === 'bookfish-wake') {
    void pollLoop();
    respond({ ok: true });
    return true;
  }
  return false;
});

void pollLoop();
