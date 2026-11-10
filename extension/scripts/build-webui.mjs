import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

// Node writes the artifact because the native esbuild executable cannot write it on this Windows volume.
const result = await build({ entryPoints: ['src/webui/client.ts'], bundle: true, format: 'esm', platform: 'browser', outfile: 'lib/webui.js', write: false });
await mkdir('lib', { recursive: true });
for (const file of result.outputFiles) await writeFile(file.path, file.contents);
console.log('Built lib/webui.js');

await import('./build-worker.mjs');
