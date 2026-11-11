/**
 * Isolated verification of the real runtime ZIP: stream it through the same
 * offline upload path as the WebUI, extract it with the production worker,
 * run the real Java/bridge self-check, and report the resulting state.
 *
 * Usage:
 *   node --import tsx scripts/verify-novel-runtime.mts [--zip <path>] [--data-dir <dir>] [--keep]
 */
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NovelRuntimeManager } from '../src/novel-runtime/manager.ts';
import { BUILTIN_RUNTIME_MANIFEST } from '../src/novel-runtime/builtin-manifest.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const zip = resolve(argument('--zip', join(PACKAGE_ROOT, 'output', 'novel-runtime', BUILTIN_RUNTIME_MANIFEST.archive.path))!);
const dataDir = resolve(argument('--data-dir', mkdtempSync(join(tmpdir(), 'bookfish-runtime-verify-')))!);
const keep = process.argv.includes('--keep');
const manager = new NovelRuntimeManager({
  dataDir,
  workDir: join(dataDir, 'bookfish', 'novel-fetch'),
  bridgeClasses: join(PACKAGE_ROOT, 'src', 'novel-bridge', 'classes'),
  manifest: BUILTIN_RUNTIME_MANIFEST,
});

let failed = false;
try {
  const size = statSync(zip).size;
  console.log(JSON.stringify({ step: 'start', zip, size, dataDir }));
  await manager.start();
  const begin = manager.importBegin({ size, filename: 'runtime.zip' });
  const fd = openSync(zip, 'r');
  try {
    const buffer = Buffer.alloc(begin.chunkBytes);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!read) break;
      const result = manager.importChunk(begin.id, offset, buffer.subarray(0, read).toString('base64'));
      offset = result.offset;
      process.stdout.write(`\rupload ${offset}/${size}`);
    }
  } finally { closeSync(fd); }
  process.stdout.write('\n');
  manager.importFinish(begin.id);
  const started = Date.now();
  for (;;) {
    const status = manager.status();
    const phase = status.install?.phase;
    if (phase === 'failed' || phase === 'cancelled' || phase === 'interrupted') {
      console.error(JSON.stringify({ ok: false, phase, error: status.install?.error, install: status.install }, null, 2));
      failed = true;
      break;
    }
    if (phase === 'ready') {
      console.log(JSON.stringify({ ok: status.usable, status }, null, 2));
      if (!status.usable) failed = true;
      break;
    }
    if (phase) process.stdout.write(`\rphase ${phase}${status.install?.percent !== null && status.install?.percent !== undefined ? ` ${status.install.percent}%` : ''}`);
    if (Date.now() - started > 10 * 60_000) { console.error('timed out'); failed = true; break; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
  }
  const probe = await manager.probe();
  console.log(JSON.stringify({ probe }, null, 2));
  if (!probe.ok) failed = true;
  const source = await manager.checkSource();
  console.log(JSON.stringify({ source }, null, 2));
  await manager.stop();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  if (!keep && !argument('--data-dir')) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } }
}
process.exit(failed ? 1 : 0);
