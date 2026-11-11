/**
 * Compile the one-shot SonovelBridge against the official so-novel fat jar.
 *
 * The previous comparison already downloaded an isolated ECJ compiler, so no
 * system JDK is required. Set SONOVEL_RESEARCH_ROOT to reuse another checkout.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '../..');
export const RESEARCH_ROOT = process.env.SONOVEL_RESEARCH_ROOT ?? resolve(PACKAGE_ROOT, '../../research/novel-fetch-20261109');
export const RUNTIME_DIR = process.env.SONOVEL_RUNTIME_DIR ?? join(RESEARCH_ROOT, 'sonovel-runtime', 'SoNovel');
const JAVA = process.env.SONOVEL_JAVA ?? join(RUNTIME_DIR, 'runtime', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const ECJ = join(RESEARCH_ROOT, 'ecj.jar');
const OUT = join(HERE, 'bridge', 'classes');

export function compileBridge() {
  for (const [label, file] of [['app.jar', join(RUNTIME_DIR, 'app.jar')], ['java', JAVA], ['ecj.jar', ECJ]]) {
    if (!existsSync(file)) throw new Error(`Missing ${label}: ${file}`);
  }
  mkdirSync(OUT, { recursive: true });
  const result = spawnSync(JAVA, [
    '-jar', ECJ, '-source', '21', '-target', '21',
    '-cp', join(RUNTIME_DIR, 'app.jar'),
    '-d', OUT,
    join(HERE, 'bridge', 'SonovelBridge.java'),
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Bridge compilation failed:\n${result.stdout}\n${result.stderr}`);
  return join(OUT, 'SonovelBridge.class');
}

if (process.argv[1] && process.argv[1].endsWith('build-bridge.mjs')) {
  console.log(`compiled ${compileBridge()}`);
}
