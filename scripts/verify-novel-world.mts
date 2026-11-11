/**
 * Isolated World verification: install the real runtime, then exercise the same
 * panel path the user uses (search by title → queue → integrity gate → shelf)
 * without touching the user's Coopanion instance.
 *
 * Usage:
 *   node --import tsx scripts/verify-novel-world.mts --title 狂人日记 [--zip <path>] [--data-dir <dir>] [--keep] [--no-fetch]
 */
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOKFISH } from '../src/definition.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { FakeHost } from '../tests/helpers/fake-host.ts';
import { NovelRuntimeManager } from '../src/novel-runtime/manager.ts';
import { BUILTIN_RUNTIME_MANIFEST } from '../src/novel-runtime/builtin-manifest.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const zip = resolve(argument('--zip', join(PACKAGE_ROOT, 'output', 'novel-runtime', BUILTIN_RUNTIME_MANIFEST.archive.path))!);
const dataDir = resolve(argument('--data-dir', mkdtempSync(join(tmpdir(), 'bookfish-world-verify-')))!);
const title = argument('--title', '狂人日记')!;
const keep = process.argv.includes('--keep');
const fetchBook = !process.argv.includes('--no-fetch');

function sleep(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

async function install(dataDir: string): Promise<void> {
  const manager = new NovelRuntimeManager({
    dataDir, workDir: join(dataDir, 'bookfish', 'novel-fetch'),
    bridgeClasses: join(PACKAGE_ROOT, 'src', 'novel-bridge', 'classes'), manifest: BUILTIN_RUNTIME_MANIFEST,
  });
  await manager.start();
  if (manager.status().usable) { await manager.stop(); return; }
  const size = statSync(zip).size;
  const begin = manager.importBegin({ size, filename: 'runtime.zip' });
  const fd = openSync(zip, 'r');
  try {
    const buffer = Buffer.alloc(begin.chunkBytes);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!read) break;
      offset = manager.importChunk(begin.id, offset, buffer.subarray(0, read).toString('base64')).offset;
    }
  } finally { closeSync(fd); }
  manager.importFinish(begin.id);
  const started = Date.now();
  for (;;) {
    const phase = manager.status().install?.phase;
    if (phase === 'ready') break;
    if (phase === 'failed' || phase === 'cancelled' || phase === 'interrupted') throw new Error(`runtime install ${phase}: ${manager.status().install?.error?.message}`);
    if (Date.now() - started > 10 * 60_000) throw new Error('runtime install timed out');
    await sleep(400);
  }
  if (!manager.status().usable) throw new Error('runtime installed but not usable');
  await manager.stop();
}

let failed = false;
let world: ReturnType<typeof BOOKFISH.create> | undefined;
try {
  // fakeWorldContext places the deployment at <scratch>/deployment, so the
  // runtime must be installed into that same data directory.
  const worldDataDir = join(dataDir, 'deployment', 'data');
  await install(worldDataDir);
  const context = fakeWorldContext(BOOKFISH, { scratchDir: dataDir });
  context.persist({ allowNetwork: true, automaticReading: false, realRoutineEnabled: false });
  world = BOOKFISH.create(context);
  const host = new FakeHost();
  await world.start(host);
  const invoke = world.webUi!('zh').invoke!;
  const status = await invoke('shelf', 'novel_status', []) as { available: boolean; reason?: string; engineVersion: string | null };
  console.log(JSON.stringify({ step: 'status', status }));
  if (!status.available) throw new Error(`engine unavailable: ${status.reason}`);
  const runtime = await invoke('shelf', 'runtime_status', []) as { usable: boolean; source: string; health: { message?: string } };
  console.log(JSON.stringify({ step: 'runtime', runtime }));
  if (!runtime.usable) throw new Error('runtime not usable');

  const job = await invoke('shelf', 'novel_search_start', [{ title }]) as { id: string; state: string };
  let search: { state: string; completed: number; total: number; candidates?: Array<Record<string, unknown>>; error?: string } | undefined;
  const searchStart = Date.now();
  for (;;) {
    search = await invoke('shelf', 'novel_search_status', [job.id]) as typeof search;
    if (search && (search.state === 'complete' || search.state === 'failed')) break;
    if (Date.now() - searchStart > 8 * 60_000) throw new Error('search timed out');
    await sleep(800);
  }
  if (!search || search.state !== 'complete') throw new Error(`search failed: ${search?.error}`);
  console.log(JSON.stringify({ step: 'search', completed: search.completed, total: search.total, count: search.candidates?.length ?? 0, candidates: (search.candidates ?? []).slice(0, 5).map((candidate) => ({ title: candidate.title, author: candidate.author, source: (candidate.source as { name: string }).name, match: candidate.match })) }));
  if (!fetchBook) { await world.stop(); world = undefined; process.exit(0); }
  const candidate = (search.candidates ?? []).find((item) => item.match === 'exact');
  if (!candidate) throw new Error('no exact candidate to fetch');
  const task = await invoke('shelf', 'novel_fetch', [candidate]) as { id: string; state: string };
  let record: { state: string; stage: string; downloadedChapters: number; catalogChapters: number; error?: string; issues?: unknown[]; bookKey?: string } | undefined;
  const fetchStart = Date.now();
  for (;;) {
    record = await invoke('shelf', 'novel_task', [task.id]) as typeof record;
    process.stdout.write(`\rfetch ${record?.state} ${record?.stage} ${record?.downloadedChapters ?? 0}/${record?.catalogChapters ?? 0}`);
    if (record && ['complete', 'failed', 'cancelled'].includes(record.state)) break;
    if (Date.now() - fetchStart > 30 * 60_000) throw new Error('fetch timed out');
    await sleep(1500);
  }
  process.stdout.write('\n');
  console.log(JSON.stringify({ step: 'fetch', record }, null, 2));
  if (record?.state !== 'complete') { failed = true; }
  else {
    const panel = await invoke('shelf', 'get', []) as { books: Array<{ key: string; title: string; totalChars: number }>; status: { library: { current: { key: string } | null } } };
    console.log(JSON.stringify({ step: 'shelf', books: panel.books.map((book) => ({ key: book.key, title: book.title, totalChars: book.totalChars })) }));
    if (!panel.books.length) failed = true;
    else {
      const reader = await invoke('shelf', 'reader', [{ bookKey: panel.books[0]!.key, segment: 1 }]) as { segments?: Array<{ text: string }> };
      const text = (reader.segments ?? []).map((segment) => segment.text).join('\n');
      console.log(JSON.stringify({ step: 'reader', chars: text.length, preview: text.slice(0, 60) }));
      if (text.length < 20) failed = true;
    }
  }
  await world.stop();
  world = undefined;
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  if (world) { try { await world.stop(); } catch { /* best effort */ } }
  if (!keep && !argument('--data-dir')) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } }
}
process.exit(failed ? 1 : 0);
