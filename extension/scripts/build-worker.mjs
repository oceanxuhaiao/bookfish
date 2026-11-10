import {mkdir,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
await mkdir('lib',{recursive:true});

const worker = await build({entryPoints:['src/import-worker.ts'],bundle:true,format:'esm',platform:'node',target:'node22',packages:'external',outfile:'lib/import-worker.mjs',write:false});
for(const file of worker.outputFiles)await writeFile(file.path,file.contents);
console.log('Built lib/import-worker.mjs');

// The ZIP worker bundles yauzl so the extension package does not need a
// production dependency at the host install path.
const zipWorker = await build({entryPoints:['src/novel-runtime/zip-worker.ts'],bundle:true,format:'esm',platform:'node',target:'node22',outfile:'lib/zip-worker.mjs',write:false,
  banner:{js:"import { createRequire as __bookfishCreateRequire } from 'node:module'; const require = __bookfishCreateRequire(import.meta.url);"}});
for(const file of zipWorker.outputFiles)await writeFile(file.path,file.contents);
console.log('Built lib/zip-worker.mjs');
