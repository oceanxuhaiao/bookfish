/** Acquire 昆虫记 through the live host panel API and leave it on the shelf. */
const base = 'http://127.0.0.1:17788/api/webui/providers/world%3Abookfish/panels/';
async function call(panel, method, args = []) {
  const r = await fetch(`${base}${panel}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method}: HTTP ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const search = await call('shelf', 'novel_search_start', [{ title: '昆虫记' }]);
const searchId = search.id;
let status;
for (let i = 0; i < 120; i++) {
  status = await call('shelf', 'novel_search_status', [searchId]);
  if (['complete', 'failed', 'cancelled'].includes(status.state)) break;
  await wait(2000);
}
const candidates = status.candidates ?? [];
console.log('search', status.state, 'candidates', candidates.length);
const pick = candidates.find((c) => c.title?.replace(/\s+/gu, '') === '昆虫记' && c.source?.name === '香书小说')
  ?? candidates.find((c) => c.title?.replace(/\s+/gu, '') === '昆虫记')
  ?? candidates[0];
if (!pick) throw new Error('no candidate');
console.log('pick', JSON.stringify({ keys: Object.keys(pick), id: pick.id, title: pick.title, author: pick.author, source: pick.source?.name, chapters: pick.chapters }));
const started = await call('shelf', 'novel_fetch', [pick]);
const taskId = started.id ?? started.taskId;
console.log('task', taskId);
let task;
for (let i = 0; i < 180; i++) {
  task = await call('shelf', 'novel_task', [taskId]);
  if (['complete', 'failed', 'cancelled'].includes(task.state)) break;
  await wait(2000);
}
console.log(JSON.stringify({ state: task.state, stage: task.stage, percent: task.percent, error: task.error ?? null, issues: (task.issues ?? []).length, warnings: (task.warnings ?? []).map((w) => w.code), bookKey: task.bookKey ?? null }, null, 2));
const shelf = await call('status', 'get');
console.log('shelf', shelf.books.length, shelf.books.map((b) => b.title).join(' | '));
