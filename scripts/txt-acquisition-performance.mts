/** Synthetic load measurement. Does not read production books or call models. */
import { mkdirSync, openSync, closeSync, writeSync, statSync, existsSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { prepareFileBestEffort, importFileBlobBestEffort } from '../src/stream-import.ts';
const mib=Number(process.argv[2]??20);const root=resolve('_verify/performance');mkdirSync(root,{recursive:true});
const file=join(root,`synthetic-${mib}MiB.txt`);const size=Math.floor(mib*1024*1024);
if(!existsSync(file)||statSync(file).size!==size){const fd=openSync(file,'w');const chunk=Buffer.from(('第1章 海风\n她把信折好，回到窗口等船。\n').repeat(256));try{let left=size;while(left){const count=Math.min(left,chunk.length);writeSync(fd,chunk,0,count);left-=count;}}finally{closeSync(fd);}}
global.gc?.();const initial=process.memoryUsage();const started=performance.now();const decoded=prepareFileBestEffort(file);const decodeMs=performance.now()-started;
const decodeMemory=process.memoryUsage();const decodePeak=process.resourceUsage().maxRSS*1024;
const out=join(root,`indexed-${mib}`);mkdirSync(out,{recursive:true});const importStart=performance.now();const result=importFileBlobBestEffort(out,file,{filename:'synthetic.txt',title:`Synthetic ${mib}MiB`},16384,undefined,decoded);
console.log(JSON.stringify({synthetic:true,mib,bytes:size,encoding:decoded.encoding,textChars:decoded.metrics?.totalChars,replacements:decoded.replacements,decodeMs,importMs:performance.now()-importStart,initialRss:initial.rss,decodeRss:decodeMemory.rss,decodePeakRss:decodePeak,finalRss:process.memoryUsage().rss,peakRss:process.resourceUsage().maxRSS*1024,id:result.id}));
