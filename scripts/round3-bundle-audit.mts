import {build} from 'esbuild';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const result=await build({entryPoints:['src/novel-runtime/zip-worker.ts'],bundle:true,format:'esm',platform:'node',target:'node22',outfile:'lib/zip-worker.mjs',write:false,metafile:true,banner:{js:"import { createRequire as __bookfishCreateRequire } from 'node:module'; const require = __bookfishCreateRequire(import.meta.url);"}});
const expected=readFileSync('lib/zip-worker.mjs');const generated=result.outputFiles![0].contents;const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const inputs=Object.keys(result.metafile!.inputs);const report={node:process.version,sameAsShipped:hash(expected)===hash(generated),sha256:hash(expected),inputs,containsYauzl321:inputs.some(p=>p.includes('yauzl@3.2.1')),containsAuditTestTools:inputs.filter(p=>/vitest|tinypool|vite\/|vite-node|esbuild\/lib/.test(p))};
mkdirSync('_verify',{recursive:true});writeFileSync('_verify/r3-bundle-audit.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.sameAsShipped||!report.containsYauzl321||report.containsAuditTestTools.length)process.exitCode=1;
