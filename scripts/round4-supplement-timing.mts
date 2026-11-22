/** Small deterministic full-import comparison; no model or real network. */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
const [sourceArg,run]=process.argv.slice(2);if(!sourceArg||!run)throw Error('Usage: sourceRoot runId');
const source=resolve(sourceArg);
const {Library}=await import(pathToFileURL(join(source,'src/library.ts')).href);
const {SelectionCoordinator}=await import(pathToFileURL(join(source,'src/selection.ts')).href);
const {TxtAcquisition}=await import(pathToFileURL(join(source,'src/txt-acquisition/acquisition.ts')).href);
const {BOOKFISH_DEFAULTS}=await import(pathToFileURL(join(source,'src/config.ts')).href);
const sentence='她把信折好，回到窗口等船。';
const bytes=Buffer.from('第1章 海风\n\n'+sentence.repeat(Math.floor((1048576-32)/Buffer.byteLength(sentence)))+'\n');
const dataDir=resolve('_verify/supplement-timing',run+'-'+randomUUID());
const library=new Library({dataDir});library.open();
let acq:any;const cfg={...BOOKFISH_DEFAULTS,txtAcquisitionEnabled:true,autonomousAcquisition:true,allowNetwork:true};
const selection=new SelectionCoordinator({library,novelFetches:{persisted:()=>undefined} as any,scheduler:{} as any,cfg:()=>cfg,timezone:'UTC',getExternalTask:(id:string)=>acq.records.get(id),isExternalTask:(id:string)=>!!acq.records.get(id),cancelExternal:(id:string)=>acq.cancelByIntentId(id)} as any);
acq=new TxtAcquisition({dataDir,library,cfg:()=>cfg,resolve:async()=>['93.184.216.34'],fetchImpl:async()=>new Response(bytes),onTaskCreated:(t:any)=>selection.onExternalTaskCreated(t),onTaskStateChanged:(t:any)=>selection.onExternalTaskStateChanged(t),onImported:(t:any,i:any)=>selection.onExternalImport(t,i)} as any);
await acq.init();selection.start({pushEvent:async()=>undefined} as any);const id=randomUUID(),now=Date.now();library.updateSelection((s:any)=>s.intents.push({id,title:'海风',author:'小鱼',reason:'本地性能夹具',status:'proposed',origin:'autonomous',candidates:[],queueOnImport:true,createdAt:now,updatedAt:now}));
try{const start=performance.now();const result=await acq.importFile({url:'https://books.example/'+encodeURIComponent('《海风》作者：小鱼')+'.txt',title:'海风',author:'小鱼',origin:'autonomous',intentId:id});const ms=performance.now()-start;if(!result.status.startsWith('completed')||library.list()[0].confirmedChars!==0||library.selection().queue.length!==1)throw Error('Invalid benchmark result '+JSON.stringify({result,intent:library.selection().intents[0],queue:library.selection().queue.length}));console.log(JSON.stringify({run,source,node:process.version,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),ms,peakRssMiB:process.resourceUsage().maxRSS/1024,confirmedChars:0,queue:1,scope:'1MiB acquisition including source identity, raw hash/snapshot, import and Selection receipt; deterministic injected response, no real network/model'}));}finally{await selection.stop();await acq.stop();library.close();}
