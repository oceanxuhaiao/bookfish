/**
 * Rebuild the Java bridge against a pinned so-novel JAR.
 *
 * The runtime ZIP never ships the bridge. Keeping the class in the extension
 * package means every install uses the exact bridge the extension tested.
 *
 * Usage:
 *   node scripts/build-novel-bridge.mjs --java <java.exe> --ecj <ecj.jar> --app-jar <app.jar>
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return resolve(index >= 0 ? process.argv[index + 1] : fallback);
}
const java = argument('--java', process.env.BOOKFISH_JAVA ?? '');
const ecj = argument('--ecj', process.env.BOOKFISH_ECJ ?? '');
const appJar = argument('--app-jar', process.env.BOOKFISH_APP_JAR ?? '');
for (const [label, path] of [['java', java], ['ecj', ecj], ['app-jar', appJar]]) {
  if (!path || !existsSync(path)) { console.error(`Missing --${label} (${path || 'unset'})`); process.exit(2); }
}
const source = join(PACKAGE_ROOT, 'src', 'novel-bridge', 'SonovelBridge.java');
const output = join(PACKAGE_ROOT, 'src', 'novel-bridge', 'classes');
mkdirSync(output, { recursive: true });
execFileSync(java, ['-jar', ecj, '-21', '-deprecation', '-cp', appJar, '-d', output, source], { stdio: 'inherit' });
console.log(`Built ${output}`);
