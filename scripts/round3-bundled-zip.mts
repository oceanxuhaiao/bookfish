import {Worker} from 'node:worker_threads';
import {resolve} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const results=[];
for(const size of [4,7,9]){const destDir=resolve('_verify/zip-time/out-'+size+'-'+Date.now());const worker=new Worker(new URL('../lib/zip-worker.mjs',import.meta.url),{workerData:{zipPath:resolve('_verify/zip-time/'+size+'.zip'),destDir},execArgv:[]});try{const result=await new Promise<any>((ok,no)=>{worker.once('message',ok);worker.once('error',no);worker.once('exit',code=>{if(code)no(Error('Worker exit '+code));});});assert.equal(result.type,'done');assert.equal(readFileSync(resolve(destDir,'fixture.txt'),'utf8'),'round3 timestamp fixture');results.push({malformedNtfsBytes:size,passed:true,worker:result.type});}finally{await worker.terminate();}}
writeFileSync('_verify/r3-bundled-zip-time.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
