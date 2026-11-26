import { createHash } from 'node:crypto';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { build } from 'esbuild';

// Node writes the artifact because the native esbuild executable cannot write it on this Windows volume.
const result = await build({ entryPoints: ['src/webui/client.ts'], bundle: true, format: 'esm', platform: 'browser', outfile: 'lib/webui.js', write: false });
await mkdir('lib', { recursive: true });
for (const file of result.outputFiles) await writeFile(file.path, file.contents);
console.log('Built lib/webui.js');
// The reading-order UI uses its own URL; released WebUI bundles are immutable.
const digest = createHash('sha256').update(await readFile('lib/webui.js')).digest('hex').slice(0, 12);
const clientPath = `lib/webui-reading-order-${digest}.js`;
await copyFile('lib/webui.js', clientPath);
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
manifest.cortico.webUiClient = clientPath;
await writeFile('package.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`WebUI asset: ${clientPath}`);

await import('./build-worker.mjs');
