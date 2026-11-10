import { open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
const base = 'http://127.0.0.1:17788';
const mode = process.argv[2] ?? 'import';
const source = resolve(process.argv[3] ?? 'output/large-file-check/sample.txt');
const title = process.argv[4] ?? '异步导入真实验收（合成，不供阅读）';
async function invoke(method, args = [], timeout = 120000) {
  const started = performance.now();
  const response = await fetch(base + '/api/webui/providers/world%3Abookfish/panels/status/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }), signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw Error(method + ': ' + (await response.text()));
  return { value: await response.json(), ms: Math.round((performance.now() - started) * 10) / 10 };
}
const terminal = ['done', 'failed', 'cancelled'];
function percentile(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null; }
function snapshot(panel) {
  return {
    books: panel.books.length,
    titles: panel.books.map((book) => book.title),
    current: panel.status.library.current?.key ?? null,
    journalTotal: panel.journal?.total ?? null,
    paused: panel.status.library.paused,
    config: panel.config,
  };
}
const beforePanel = (await invoke('get')).value;
const before = snapshot(beforePanel);
const file = await open(source, 'r');
const { size } = await file.stat();
const task = (await invoke('upload_begin', [{ filename: 'large-import-check.txt', title, author: '项目本地协议测试', size }])).value;
let offset = 0; const uploadStarted = performance.now();
try {
  while (offset < size) {
    const bytes = Buffer.alloc(Math.min(task.chunkBytes, size - offset));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
    const ack = (await invoke('upload_chunk', [task.id, offset, bytes.subarray(0, bytesRead).toString('base64')])).value;
    offset = ack.offset;
  }
} finally { await file.close(); }
const uploadMs = Math.round(performance.now() - uploadStarted);
const started = (await invoke('upload_finish', [task.id])).value;
const transitions = []; const latencies = []; let last = { state: started.state, stage: started.stage, percent: started.percent };
let cancelRequestedAt = null; let final = null; let pollError = null;
const progressLoop = (async () => {
  while (true) {
    try {
      const { value } = await invoke('transfer_status', []);
      if (!value) break;
      if (value.stage !== last.stage || value.percent !== last.percent || value.state !== last.state) {
        transitions.push({ atMs: Math.round(performance.now() - uploadStarted), state: value.state, stage: value.stage, percent: value.percent });
        last = value;
      }
      if (!cancelRequestedAt && mode === 'cancel' && value.state === 'processing' && (value.percent >= 3 || value.stage === 'index')) {
        cancelRequestedAt = performance.now();
        await invoke('transfer_cancel', [task.id]);
      }
      if (terminal.includes(value.state)) { final = value; break; }
    } catch (error) { pollError = String(error); break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
})();
const responsivenessLoop = (async () => {
  while (!final) {
    try {
      const { ms } = await invoke('get');
      latencies.push(ms);
    } catch (error) {
      if (!pollError) pollError = String(error);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
})();
if (mode === 'crash') {
  while (!final && last.state === 'processing') {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (transitions.length || last.percent > 0) {
      await writeFile('output/live-crash-ready-0.16.0.json', JSON.stringify({ id: task.id, last }, null, 2));
      break;
    }
  }
  while (true) {
    try { await invoke('transfer_status', [], 3000); await new Promise((resolve) => setTimeout(resolve, 500)); }
    catch (error) {
      await writeFile('output/live-crash-observed-0.16.0.json', JSON.stringify({ id: task.id, last, transitions, error: String(error), at: new Date().toISOString() }, null, 2));
      process.exit(0);
    }
  }
}
await Promise.all([progressLoop, responsivenessLoop]);
if (!final) throw Error(pollError ?? 'Import did not reach a terminal state');
const afterPanel = (await invoke('get')).value;
const proof = {
  version: '0.16.0', mode, sourceBytes: size, uploadMs, totalMs: Math.round(performance.now() - uploadStarted),
  cancelRequestedAtMs: cancelRequestedAt === null ? null : Math.round(cancelRequestedAt - uploadStarted),
  final, transitions,
  responsiveness: { samples: latencies.length, maxMs: Math.max(...latencies), p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95) },
  before, after: snapshot(afterPanel), result: final.result ?? null, pollError,
  limits: 'Real Coopanion host API on the local machine; page/status requests are a responsiveness proxy, not a model chat turn.',
};
const name = mode === 'cancel' ? 'live-cancel-0.16.0.json' : 'live-import-0.16.0.json';
await writeFile('output/' + name, JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof, null, 2));
