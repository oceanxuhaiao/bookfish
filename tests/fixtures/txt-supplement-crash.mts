/** Real child exit in isolated data only; never starts Coopanion or a browser. */
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Library } from '../../src/library.ts';
import { TxtAcquisition } from '../../src/txt-acquisition/acquisition.ts';
import { SelectionCoordinator } from '../../src/selection.ts';
import { BOOKFISH_DEFAULTS } from '../../src/config.ts';
const [root,phase]=process.argv.slice(2);if(!root||!phase)throw Error('Usage: privateDataDir book|receipt|recover');
const dataDir=resolve(root),library=new Library({dataDir});library.open();
const cfg={...BOOKFISH_DEFAULTS,txtAcquisitionEnabled:true,autonomousAcquisition:true,allowNetwork:true};
let acq!:TxtAcquisition;
const selection=new SelectionCoordinator({library,novelFetches:{persisted:()=>undefined} as any,scheduler:{} as any,cfg:()=>cfg,timezone:'UTC',getExternalTask:id=>acq.records.get(id),isExternalTask:id=>!!acq.records.get(id),cancelExternal:id=>acq.cancelByIntentId(id)});
acq=new TxtAcquisition({dataDir,library,cfg:()=>cfg,resolve:async()=>['93.184.216.34'],fetchImpl:async()=>new Response('她把信折好，走向窗边。'.repeat(100)),onTaskCreated:t=>selection.onExternalTaskCreated(t),onTaskStateChanged:t=>selection.onExternalTaskStateChanged(t),onImported:(t,i)=>{selection.onExternalImport(t,i);if(phase==='receipt')process.exit(23);}});
await acq.init();selection.start({pushEvent:async()=>undefined} as any);
try{
 if(phase==='recover'){
   await acq.resumeSelection();const task=acq.records.latest()!;const done=await acq.retry(task.id);
   assert.match(done.status,/^completed/);assert.equal(library.list().length,1);assert.equal(library.list()[0].confirmedChars,0);assert.equal(library.timeline(library.list()[0].key).items.length,0);assert.equal(library.selection().queue.length,1);assert.equal(acq.records.get(task.id)!.attempts.downloads,1);
   console.log(JSON.stringify({phase,books:1,queue:1,confirmedChars:0,downloads:1,selection:acq.records.get(task.id)!.selection?.status}));
 }else{
   if(phase==='book'){const original=library.importFileBestEffort.bind(library);library.importFileBestEffort=(...args)=>{original(...args);process.exit(23);};}
   const id=randomUUID(),now=Date.now();library.updateSelection(s=>s.intents.push({id,title:'海风',author:'小鱼',reason:'进程中断测试',origin:'autonomous',status:'proposed',candidates:[],queueOnImport:true,createdAt:now,updatedAt:now}));
   await acq.importFile({url:'https://books.example/'+encodeURIComponent('《海风》作者：小鱼')+'.txt',title:'海风',author:'小鱼',origin:'autonomous',intentId:id});throw Error('Expected forced exit');
 }
}finally{await selection.stop();await acq.stop();library.close();}
