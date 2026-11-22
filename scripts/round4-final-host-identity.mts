import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Library} from '../src/library.ts';
import {TxtAcquisition} from '../src/txt-acquisition/acquisition.ts';
import {BOOKFISH_DEFAULTS} from '../src/config.ts';
const loc=JSON.parse(readFileSync('_verify/host-final-current.json','utf8'));
const {base}=JSON.parse(readFileSync(join(loc.evidence,'ready.json'),'utf8'));
if(!base.startsWith('http://127.0.0.1:'))throw Error('Not an isolated host endpoint');
async function request(path:string,body:unknown){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify(body)});const out=await r.json() as any;assert.equal(r.status,200,JSON.stringify(out));return out;}
const panel=(method:string,args:any[]=[])=>request('/api/webui/providers/world%3Abookfish/panels/shelf/'+method,{args});
const records:any[]=[];
try{
 await request('/api/webui/providers/world%3Abookfish/panels/settings/save',{args:[{allowNetwork:true,autonomousAcquisition:true}]});
 await request('/api/worlds/activation',{id:'bookfish',enabled:false});
 const data=join(loc.work,'home','companion','data'),lib=new Library({dataDir:data});lib.open();
 const cfg={...BOOKFISH_DEFAULTS,allowNetwork:true,autonomousAcquisition:true,txtAcquisitionEnabled:true,browserBridgeEnabled:false};
 const acq=new TxtAcquisition({dataDir:data,library:lib,cfg:()=>cfg,resolve:async()=>['93.184.216.34'],fetchImpl:async()=>new Response('她把信折好放在窗边，听见远处海风吹动船帆。'.repeat(100))});
 await acq.init();const fixtures:any[]=[];
 try{for(const filename of ['novel.txt','《另一部》作者：小鱼.txt']){
  const id=randomUUID(),now=Date.now();lib.updateSelection(s=>s.intents.push({id,title:'海风',author:'小鱼',reason:'隔离宿主合成待确认状态',origin:'autonomous',status:'proposed',queueOnImport:true,candidates:[],createdAt:now,updatedAt:now}));
  const task=await acq.importFile({url:'https://books.example/'+encodeURIComponent(filename),title:'海风',author:'小鱼',origin:'autonomous',intentId:id});assert.match(task.status,/^completed/);
  lib.updateSelection(s=>{const i=s.intents.find(x=>x.id===id)!;Object.assign(i,{status:'awaiting_choice',queueOnImport:false,bookKey:task.bookKey,acquisitionTaskId:task.taskId,acquisitionKind:'txt',failure:{code:'identity_mismatch',message:'合成宿主恢复夹具：来源待确认',at:now}});});
  fixtures.push({id,taskId:task.taskId,bookKey:task.bookKey,filename});
 }}finally{await acq.stop();lib.close();}
 records.push({step:'offline-fixtures-prepared',scope:'actual acquisition code with injected synthetic bytes before real host recovery; not live network/browser evidence',fixtures});
 await request('/api/worlds/activation',{id:'bookfish',enabled:true});
 for(let cycle=0;cycle<3;cycle++){
  if(cycle)await request('/api/worlds/restart',{id:'bookfish'});
  for(const f of fixtures){const summary=await panel('selection_summary',[f.id]);assert.equal(summary.intent.status,'awaiting_choice');assert.equal(summary.intent.choiceStage,'import');assert.match(summary.intent.guidance,/planAction="queue"/);assert.ok(!summary.intent.guidance.includes('action="start"'));assert.equal(summary.intent.acquisitionTaskId,f.taskId);assert.equal(summary.intent.bookKey,f.bookKey);assert.equal(summary.queue.length,0);
   const display=summary.intent.txtIdentity.libraryDisplayIdentity;if(f.filename==='novel.txt'){assert.match(display.title,/^未确认作品/);assert.equal(display.author,'');assert.deepEqual(summary.intent.txtIdentity.declaredIdentity,{});}else{assert.equal(display.title,'另一部');assert.equal(display.author,'小鱼');}
  }
  records.push({step:'real-host-identity-summary-recovery',cycle,passed:true});
 }
 const abandoned=await panel('selection_abandon',[fixtures[0].id]);assert.equal(abandoned.intent.status,'abandoned');
 const shelf=await panel('get');assert.equal(shelf.books.length,4);assert.ok(shelf.books.every((b:any)=>b.confirmedChars===0));assert.equal(shelf.selection.queue.length,0);assert.equal(shelf.status.txtAcquisition.controllerReady,false);assert.equal(shelf.status.txtAcquisition.browserReady,false);
 records.push({step:'actual-host-abandon-preserves-shelf-no-reading',passed:true,books:shelf.books.map((b:any)=>({key:b.key,title:b.title,author:b.author,confirmedChars:b.confirmedChars}))});
 writeFileSync(join(loc.evidence,'identity-fixtures.json'),JSON.stringify(fixtures,null,2));
 records.push({step:'result',passed:true,liveNetwork:false,modelCalled:false,productionWorldModified:false});
}catch(e){records.push({step:'result',passed:false,error:String(e)});process.exitCode=1;}
finally{writeFileSync(join(loc.evidence,'identity-results.json'),JSON.stringify(records,null,2));}
