import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

// Node writes the artifact because the native esbuild executable cannot write it on this Windows volume.
const result = await build({ entryPoints: ['src/webui/client.ts'], bundle: true, format: 'esm', platform: 'browser', outfile: 'lib/webui.js', write: false });
await mkdir('lib', { recursive: true });
for (const file of result.outputFiles) await writeFile(file.path, file.contents);
console.log('Built lib/webui.js');
// This local 0.65.1 TXT candidate must not reuse the released UI's immutable URL.
await copyFile('lib/webui.js', 'lib/webui-txt-builtin-bing-0651.js');

await import('./build-worker.mjs');
