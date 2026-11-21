import {createReadStream,mkdirSync,writeFileSync} from 'node:fs';
import {Readable} from 'node:stream';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {Library} from '../src/library.ts';
import {TxtAcquisition} from '../src/txt-acquisition/acquisition.ts';
import {BOOKFISH_DEFAULTS} from '../src/config.ts';
const mode=process.argv[2],file=resolve('../bookfish-txt-acquisition-hardening/_verify/performance/synthetic-20MiB.txt');
const dataDir=resolve('_verify/concurrency/'+randomUUID());mkdirSync(dataDir,{recursive:true});const library=new Library({dataDir});library.open();let fetches=0;
const acq=new TxtAcquisition({dataDir,library,cfg:()=>({...BOOKFISH_DEFAULTS,allowNetwork:true,txtAcquisitionEnabled:true,browserBridgeEnabled:false}),resolve:async()=>['93.184.216.34'],fetchImpl:(async()=>{fetches++;return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream,{headers:{'content-type':'text/plain'}});}) as typeof fetch});
try{await acq.init();const start=performance.now();const get=(n:number)=>acq.importFile({url:'https://fixture.example/book.txt',title:'并发夹具'+n,author:'测试'});const results=mode==='parallel'?await Promise.all([get(1),get(2)]):[await get(1),await get(2)];assert.ok(results.every(r=>['completed','completed_with_warning'].includes(r.status)));assert.equal(library.list().length,2);assert.ok(library.list().every(b=>b.confirmedChars===0));console.log(JSON.stringify({mode,node:process.version,inputMiB:20,tasks:2,ms:performance.now()-start,peakRssMiB:process.resourceUsage().maxRSS/1024,fetches,books:2,confirmedChars:0,scope:'production acquisition with bounded synthetic file response; no actual network or browser isolation; same original bytes, distinct titles'}));}finally{await acq.stop();library.close();}

