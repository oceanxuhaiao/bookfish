/**
 * Verify adoption of an existing flat engine directory on a COPY.
 *
 * The source directory is only read. A temporary data directory is created so
 * the user's real Coopanion instance is never modified.
 *
 * Usage:
 *   node --import tsx scripts/verify-legacy-migration.mts --source "<...>/bookfish/novel-engine"
 */
import { cpSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NovelRuntimeManager } from '../src/novel-runtime/manager.ts';
import { BUILTIN_RUNTIME_MANIFEST } from '../src/novel-runtime/builtin-manifest.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
const source = argument('--source');
if (!source) { console.error('Missing --source <flat novel-engine dir>'); process.exit(2); }
const dataDir = mkdtempSync(join(tmpdir(), 'bookfish-legacy-'));
let failed = false;
try {
  const base = join(dataDir, 'bookfish', 'novel-engine');
  cpSync(resolve(source), base, { recursive: true });
  const manager = new NovelRuntimeManager({
    dataDir, workDir: join(dataDir, 'bookfish', 'novel-fetch'),
    bridgeClasses: join(PACKAGE_ROOT, 'src', 'novel-bridge', 'classes'), manifest: BUILTIN_RUNTIME_MANIFEST,
  });
  await manager.start();
  const status = manager.status();
  console.log(JSON.stringify({ status }, null, 2));
  if (status.source !== 'legacy' || !status.usable) failed = true;
  const probe = await manager.probe();
  console.log(JSON.stringify({ probe }, null, 2));
  if (!probe.ok) failed = true;
  // The legacy flat directory must still contain its extra upstream files.
  const engineJson = join(base, 'engine.json');
  try { statSync(engineJson); } catch { console.error('legacy engine.json disappeared'); failed = true; }
  await manager.stop();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  if (!process.argv.includes('--keep')) rmSync(dataDir, { recursive: true, force: true });
  else console.log(JSON.stringify({ dataDir }));
}
process.exit(failed ? 1 : 0);
