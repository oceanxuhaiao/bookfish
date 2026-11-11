/**
 * Host verification for the installed 0.56.0 package.
 *
 * Talks to the running Coopanion WebUI API (world:bookfish) and checks the
 * three fixes in the real host: exact candidate validation, the short-title
 * suggestion, and the catalog gates on the previously rejected books.
 * Read-only: it never fetches, imports or deletes a book.
 */
import { writeFileSync } from 'node:fs';

const base = 'http://127.0.0.1:17788/api/webui/providers/world%3Abookfish/panels/';

async function call(panel, method, args = []) {
  const response = await fetch(`${base}${panel}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function waitForSearch(jobId, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await call('shelf', 'novel_search_status', [jobId]);
    if (['complete', 'failed'].includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`search ${jobId} timed out in ${job.state}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function search(title, author = '') {
  const started = await call('shelf', 'novel_search_start', [{ title, author }]);
  return waitForSearch(started.id);
}

const evidence = { checkedAt: new Date().toISOString(), api: base, checks: {}, detail: {} };
const status = await call('status', 'get');
const novel = status.novel;
evidence.detail.host = {
  available: novel.available, engineVersion: novel.engineVersion, pageProbe: novel.pageProbe,
  sources: novel.sources, activeId: novel.activeId, taskCount: novel.tasks.length,
  shelfBooks: status.books.length,
};
evidence.checks.engineLoaded = novel.available === true && novel.engineVersion === '1.12.0';
evidence.checks.pageProbeEnabled = novel.pageProbe === true;
evidence.checks.allEightSources = JSON.stringify(novel.sources) === JSON.stringify([5, 7, 8, 9, 12, 1, 6, 11]);

const short = await search('女将星');
evidence.detail.shortSearch = {
  state: short.state, candidates: (short.candidates ?? []).length,
  suggestions: (short.suggestions ?? []).map((item) => ({ title: item.title, author: item.author, sources: item.sources })),
  hidden: short.hidden ?? null, checked: short.checked, checkTotal: short.checkTotal,
};
evidence.checks.suggestionShown = (short.suggestions ?? []).some((item) => item.title === '重生之女将星');
evidence.checks.noExactForShortTitle = (short.candidates ?? []).length === 0;

const dafeng = await search('大奉打更人');
const dafengOk = (dafeng.candidates ?? []).filter((candidate) => candidate.check?.ok);
evidence.detail.dafeng = {
  state: dafeng.state, exact: (dafeng.candidates ?? []).length, passed: dafengOk.length,
  passedSources: dafengOk.map((candidate) => `${candidate.source.name}:${candidate.check.chapters}`),
  hidden: dafeng.hidden ?? null,
};
evidence.checks.dafengNowPasses = dafengOk.length > 0;

const lunhui = await search('轮回乐园');
const lunhuiOk = (lunhui.candidates ?? []).filter((candidate) => candidate.check?.ok);
evidence.detail.lunhui = {
  state: lunhui.state, exact: (lunhui.candidates ?? []).length, passed: lunhuiOk.length,
  passedSources: lunhuiOk.map((candidate) => `${candidate.source.name}:${candidate.check.chapters}`),
  hidden: lunhui.hidden ?? null,
};
evidence.checks.volumeRestartsAccepted = lunhuiOk.some((candidate) => candidate.check.chapters > 4000);

const failed = Object.entries(evidence.checks).filter(([, ok]) => !ok).map(([name]) => name);
evidence.failed = failed;
evidence.ok = failed.length === 0;
writeFileSync('output/live-host-0.56.0.json', `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(evidence, null, 2));
process.exitCode = evidence.ok ? 0 : 1;
