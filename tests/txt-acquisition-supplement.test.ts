import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Library } from '../src/library.ts';
import { SelectionCoordinator } from '../src/selection.ts';
import { TxtAcquisition } from '../src/txt-acquisition/acquisition.ts';
import { BOOKFISH_DEFAULTS } from '../src/config.ts';

const body='她把信折好放进抽屉，海风从窗口吹进来，桌上的灯忽明忽暗。'.repeat(80);
const exactUrl='https://books.example/'+encodeURIComponent('《海风》作者：小鱼')+'.txt';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const dispose of cleanup.splice(0))await dispose();});
function barrier(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return{promise,release};}
async function fixture(options:{fetchImpl?:typeof fetch;html?:string;beforeReceipt?:()=>Promise<void>}={}){
  const dir=mkdtempSync(join(tmpdir(),'bf-supplement-'));let library=new Library({dataDir:dir});library.open();
  const cfg={...BOOKFISH_DEFAULTS,txtAcquisitionEnabled:true,autonomousAcquisition:true,allowNetwork:true,browserBridgeEnabled:false,browserDebugPort:9333};
  let selection!:SelectionCoordinator;let acq!:TxtAcquisition;
  const make=()=>{
    selection=new SelectionCoordinator({library,novelFetches:{persisted:()=>undefined} as any,scheduler:{} as any,cfg:()=>cfg,timezone:'UTC',
      cancelExternal:(id:string,reason?:'restart_interrupted')=>acq.cancelByIntentId(id,reason),isExternalTask:(id:string)=>!!acq.records.get(id),getExternalTask:(id:string)=>acq.records.get(id)} as any);
    acq=new TxtAcquisition({dataDir:dir,library,cfg:()=>cfg,resolve:async()=>['93.184.216.34'],fetchImpl:options.fetchImpl??(async()=>new Response(body)),
      pageLoader:async()=>({html:options.html??'<html></html>',close:async()=>undefined}),
      onTaskCreated:(task:any)=>selection.onExternalTaskCreated(task),onTaskStateChanged:(task:any)=>(selection as any).onExternalTaskStateChanged(task),
      onImported:async(task:any,identity:any)=>{await options.beforeReceipt?.();selection.onExternalImport(task,identity);}} as any);
  };
  make();await acq.init();selection.start({pushEvent:async()=>undefined} as any);
  const id=randomUUID(),now=Date.now();library.updateSelection(s=>{s.intents.push({id,title:'海风',author:'小鱼',reason:'测试',status:'proposed',origin:'autonomous',createdAt:now,updatedAt:now,candidates:[],queueOnImport:true});});
  cleanup.push(async()=>{await selection.stop();await acq.stop();library.close();rmSync(dir,{recursive:true,force:true});});
  return{get library(){return library;},get selection(){return selection;},get acq(){return acq;},cfg,id,
    intent:()=>library.selection().intents.find(i=>i.id===id)!,
    import:(url=exactUrl)=>acq.importFile({url,title:'海风',author:'小鱼',intentId:id,origin:'autonomous'}),
    restart:async()=>{await selection.stop();await acq.stop();library.close();library=new Library({dataDir:dir});library.open();make();await acq.init();selection.start({pushEvent:async()=>undefined} as any);await acq.resumeSelection();}};
}

describe('supplement identity provenance',()=>{
  it('holds contradictory leading metadata for confirmation without rejecting readable prose',async()=>{
    const f=await fixture({fetchImpl:async()=>new Response('书名：另一部\n作者：小鱼\n\n'+body)});const done=await f.import();
    expect(done.status).toMatch(/^completed/);expect(f.acq.records.get(done.taskId)?.selection?.identity).toBe('partial');
    await f.restart();await f.restart();expect(f.intent().status).toBe('awaiting_choice');expect(f.library.selection().queue).toHaveLength(0);
  });
  it('downgrades legacy exact receipts whose independent source declarations are absent',async()=>{
    const f=await fixture();const done=await f.import();f.acq.records.update(done.taskId,task=>{delete task.candidates[0].title;delete task.candidates[0].author;task.selection={status:'pending',identity:'exact'};});
    f.library.updateSelection(state=>{const intent=state.intents[0];intent.status='acquiring';delete intent.bookKey;});f.library.updatePlan(plan=>{plan.items=[];plan.revision+=1;});
    await f.restart();await f.restart();expect(f.intent().status).toBe('awaiting_choice');expect(f.library.selection().queue).toHaveLength(0);expect(f.acq.records.get(done.taskId)?.selection?.identity).toBe('unknown');
  });
  it.each([
    ['《海风》.txt','partial'],['《海风》作者：小鱼.txt','exact'],
    ['《海风（修订版）》作者：小鱼.txt','partial'],['《海风续》作者：小鱼.txt','partial'],['《另一部》作者：小鱼.txt','partial'],
  ])('uses only independent filename declarations %s',async(filename,identity)=>{
    const f=await fixture();const result=await f.import('https://books.example/'+encodeURIComponent(filename));
    expect(result.status).toMatch(/^completed/);expect(f.acq.records.get(result.taskId)?.selection?.identity).toBe(identity);
    expect(f.library.selection().queue.length).toBe(identity==='exact'?1:0);
  });
  it.each(['','《海风》','《海风》作者：小鱼'])('keeps discovered anchor lineage independent: %s',async label=>{
    const f=await fixture({html:`<a href="novel.txt">${label}</a>`});
    const found=await f.acq.discover({pageUrl:'https://books.example/page',title:'海风',author:'小鱼',origin:'autonomous',intentId:f.id});
    const result=await f.acq.importFile({taskId:found.taskId,candidateId:found.candidates![0].candidateId});
    expect(result.status).toMatch(/^completed/);expect(f.acq.records.get(result.taskId)?.selection?.identity).toBe(label.includes('作者')?'exact':label?'partial':'unknown');
    if(!label.includes('作者')){await f.restart();await f.restart();expect(f.library.selection().queue).toHaveLength(0);}
  });
  it('does not create autonomous receipts for a manual import even if a caller supplies an intent id',async()=>{
    const f=await fixture();const result=await f.acq.importFile({url:exactUrl,title:'海风',author:'小鱼',origin:'manual',intentId:f.id});
    expect(result.status).toMatch(/^completed/);expect(f.acq.records.get(result.taskId)?.selection).toBeUndefined();expect(f.intent().status).toBe('proposed');expect(f.library.selection().queue).toHaveLength(0);
  });
  it.each(['novel.txt','download?id=1','123.txt','abcdef1234567890abcdef1234567890.txt'])('never fills independent identity from wanted fields: %s',async name=>{
    const f=await fixture();const result=await f.import('https://books.example/'+name);
    expect(result.status).toMatch(/^completed/);expect(f.acq.records.get(result.taskId)?.selection?.identity).not.toBe('exact');
    expect(f.intent().status).toBe('awaiting_choice');expect(f.library.selection().queue).toHaveLength(0);
    await f.restart();await f.restart();expect(f.intent().queueOnImport).toBe(false);expect(f.library.selection().queue).toHaveLength(0);
  });
  it('preserves actual filename metadata across an explicit retry',async()=>{
    const f=await fixture();const fault=vi.spyOn(f.library,'importFileBestEffort').mockImplementationOnce(()=>{throw Error('temporary import failure');});
    const first=await f.import();fault.mockRestore();const retried=await f.acq.retry(first.taskId);
    expect(retried.status).toMatch(/^completed/);expect(f.acq.records.get(first.taskId)?.selection?.identity).toBe('exact');expect(f.library.selection().queue).toHaveLength(1);
  });
});
describe('supplement terminal reconciliation',()=>{
  it('keeps World shutdown distinct from an explicit cancellation through two restarts',async()=>{
    const started=barrier();const f=await fixture({fetchImpl:async()=>{started.release();return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('第一章\n'));}}));}});
    const running=f.import();await started.promise;await f.selection.stop();await f.acq.stop();const interrupted=await running;
    expect(interrupted.failure?.code).toBe('restart_interrupted');await f.restart();await f.restart();expect(f.intent().status).toBe('deferred');expect(f.intent().failure?.code).toBe('txt_retry_available');expect(f.library.selection().queue).toHaveLength(0);
  });
  it('pulls a committed fact after a lost callback without waiting indefinitely for a restart',async()=>{
    const f=await fixture();vi.spyOn(f.selection,'onExternalImport').mockImplementationOnce(()=>{throw Error('lost callback');});
    const done=await f.import();expect(f.acq.records.get(done.taskId)?.selection?.status).toBe('failed');
    f.selection.refresh();expect(f.intent().status).toBe('reading');expect(f.library.selection().queue).toHaveLength(1);
    await f.acq.retry(done.taskId);expect(f.acq.records.get(done.taskId)?.selection?.status).toBe('completed');expect(f.library.selection().queue).toHaveLength(1);
  });
  it('does not authorize a retry or a new download for an already cancelled intent',async()=>{
    const request=vi.fn(async()=>new Response(body,{status:404}));const f=await fixture({fetchImpl:request});
    const first=await f.import();f.selection.cancel(f.id);const before=request.mock.calls.length;
    const retried=await f.acq.retry(first.taskId);expect(retried.failure?.code).toBe('cancelled');expect(request).toHaveBeenCalledTimes(before);
    await expect(f.import()).rejects.toThrow(/not active/);expect(f.intent().status).toBe('cancelled');expect(f.library.selection().queue).toHaveLength(0);
  });
  it('retries a recoverable HTTP failure on the same task and ignores a stale failure event',async()=>{
    let calls=0;const f=await fixture({fetchImpl:async()=>new Response(body,{status:++calls===1?404:200})});
    const failed=await f.import(),old=f.acq.records.get(failed.taskId)!;
    const done=await f.acq.retry(failed.taskId);expect(done.taskId).toBe(failed.taskId);expect(done.status).toMatch(/^completed/);
    f.selection.onExternalTaskStateChanged(old);expect(f.intent().status).toBe('reading');expect(f.library.selection().queue).toHaveLength(1);expect(f.library.list()[0].confirmedChars).toBe(0);
  });
  it('reconciles an encoding rejection as terminal without occupying acquiring after two restarts',async()=>{
    const f=await fixture({fetchImpl:async()=>new Response(Buffer.alloc(4096))});const failed=await f.import();expect(failed.status).toBe('failed_terminal');
    await f.restart();await f.restart();expect(f.intent().status).toBe('failed');expect(f.library.selection().queue).toHaveLength(0);
  });
  it('reconciles an expired discovered candidate without starting a download',async()=>{
    const request=vi.fn(async()=>new Response(body));const f=await fixture({fetchImpl:request,html:'<a href="novel.txt">《海风》作者：小鱼</a>'});
    const found=await f.acq.discover({pageUrl:'https://books.example/page',title:'海风',author:'小鱼',origin:'autonomous',intentId:f.id});
    f.acq.records.update(found.taskId,t=>{t.candidates[0].expiresAt=Date.now()-1;});
    const failed=await f.acq.importFile({taskId:found.taskId,candidateId:found.candidates![0].candidateId});expect(failed.failure?.code).toBe('candidate_expired');expect(request).not.toHaveBeenCalled();
    await f.restart();await f.restart();expect(f.intent().status).toBe('deferred');
  });
  it('treats a missing TXT task as unavailable instead of inferring a matching shelved book',async()=>{
    const f=await fixture({fetchImpl:async()=>new Response(body,{status:404})});const failed=await f.import();
    f.library.updateSelection(s=>{s.intents[0].status='acquiring';});
    const state=JSON.parse(readFileSync(f.acq.records.file,'utf8'));state.tasks=state.tasks.filter((t:any)=>t.id!==failed.taskId);writeFileSync(f.acq.records.file,JSON.stringify(state));
    await f.restart();await f.restart();expect(f.intent().failure?.code).toBe('txt_state_unavailable');expect(f.library.selection().queue).toHaveLength(0);
  });
  it.each(['no_candidates','http404','disk'] as const)('does not hold acquiring after %s, including two storage restarts',async failure=>{
    const f=await fixture({fetchImpl:async()=>new Response(body,{status:failure==='http404'?404:200})});
    if(failure==='disk')vi.spyOn(f.library,'importFileBestEffort').mockImplementationOnce(()=>{throw Object.assign(Error('disk'),{code:'ENOSPC'});});
    const result=failure==='no_candidates'?await f.acq.discover({pageUrl:'https://books.example/page',title:'海风',author:'小鱼',intentId:f.id,origin:'autonomous'}):await f.import();
    expect(result.status).toMatch(/^failed/);expect(f.intent().status).not.toBe('acquiring');
    await f.restart();await f.restart();expect(f.intent().status).not.toBe('acquiring');expect(f.library.selection().queue).toHaveLength(0);
  });
});
describe('supplement durable policy revocation',()=>{
  it('preserves a user cancellation when policy revocation and a late callback compete',async()=>{
    const entered=barrier(),resume=barrier();const f=await fixture({beforeReceipt:async()=>{entered.release();await resume.promise;}});
    const running=f.import();await entered.promise;f.selection.cancel(f.id);f.cfg.allowNetwork=false;f.selection.onConfigChanged();resume.release();await running;
    expect(f.intent().status).toBe('cancelled');expect(f.library.list()[0].confirmedChars).toBe(0);expect(f.library.selection().queue).toHaveLength(0);
  });
  it('migrates an old deferred policy_changed record into a persistent revocation fence',async()=>{
    const f=await fixture();const result=await f.import();
    f.library.updateSelection(state=>{const intent=state.intents[0];intent.status='deferred';intent.failure={code:'policy_changed',message:'legacy policy',at:Date.now()};delete intent.externalPolicyRevokedAt;});f.library.updatePlan(plan=>{plan.items=[];plan.revision+=1;});
    await f.restart();await f.restart();f.selection.onExternalImport({id:result.taskId,intentId:f.id,bookKey:f.library.list()[0].key},'exact');
    expect(f.intent().externalPolicyRevokedAt).toBeDefined();expect(f.intent().status).toBe('deferred');expect(f.library.selection().queue).toHaveLength(0);
  });
  it('requires an explicit permitted plan to resume a revoked committed book',async()=>{
    const entered=barrier(),resume=barrier();const f=await fixture({beforeReceipt:async()=>{entered.release();await resume.promise;}});
    const running=f.import();await entered.promise;f.cfg.allowNetwork=false;f.selection.onConfigChanged();resume.release();await running;
    expect(()=>f.selection.plan(f.id,'queue')).toThrow(/disabled/);f.cfg.allowNetwork=true;
    expect(f.library.selection().queue).toHaveLength(0);f.selection.plan(f.id,'queue');expect(f.library.selection().queue).toHaveLength(1);expect(f.intent().externalPolicyRevokedAt).toBeUndefined();
  });
  it.each(['allowNetwork','autonomousAcquisition'] as const)('does not revive a deferred intent after %s is revoked behind the committed shelf barrier',async key=>{
    const entered=barrier(),resume=barrier();const f=await fixture({beforeReceipt:async()=>{entered.release();await resume.promise;}});
    const running=f.import();await entered.promise;expect(f.library.list()).toHaveLength(1);
    f.cfg[key]=false;f.selection.onConfigChanged();f.acq.onConfigChanged();expect(f.intent().status).toBe('deferred');resume.release();const result=await running;
    expect(f.intent().status).toBe('deferred');expect(f.intent().queueOnImport).toBe(false);expect(f.library.selection().queue).toHaveLength(0);expect(f.library.list()[0].confirmedChars).toBe(0);
    f.cfg[key]=true;f.selection.onConfigChanged();f.selection.onExternalImport({id:result.taskId,intentId:f.id,bookKey:f.library.list()[0].key},'exact');
    await f.restart();await f.restart();expect(f.intent().status).toBe('deferred');expect(f.library.selection().queue).toHaveLength(0);
  });
});
describe('supplement unsettled receipt retention',()=>{
  it('replays a committed but unpersisted receipt once after two restarts and 110 histories',async()=>{
    const f=await fixture();const update=f.acq.records.update.bind(f.acq.records);let armed=true;
    vi.spyOn(f.acq.records,'update').mockImplementation((id,mutate,options)=>{
      const probe=f.acq.records.get(id)!;mutate(probe);if(armed&&probe.selection?.status==='completed'){armed=false;throw Object.assign(Error('receipt disk full'),{code:'ENOSPC'});}return update(id,mutate,options);
    });
    const done=await f.import();expect(f.acq.records.get(done.taskId)?.selection?.status).toBe('pending');expect(f.library.selection().queue).toHaveLength(1);
    const template=f.acq.records.get(done.taskId)!;for(let n=0;n<110;n++)f.acq.records.put({...template,id:randomUUID(),file:undefined,intentId:undefined,selection:undefined});
    expect(f.acq.records.get(done.taskId)).toBeTruthy();await f.restart();await f.restart();expect(f.acq.records.get(done.taskId)?.selection?.status).toBe('completed');expect(f.library.selection().queue).toHaveLength(1);expect(f.library.list()).toHaveLength(1);
  });
  it('makes the receipt backlog observable and refuses new tasks without orphan records',async()=>{
    const f=await fixture();const done=await f.import(),template=f.acq.records.get(done.taskId)!;
    for(let n=0;n<100;n++)f.acq.records.put({...template,id:randomUUID(),file:undefined,selection:{status:'pending',identity:'exact'}});
    const before=f.acq.records.list().length;expect(f.acq.summary().history.pendingSelectionReceipts).toBe(100);
    await expect(f.import()).rejects.toThrow(/backlog/);expect(f.acq.records.list()).toHaveLength(before);
    const manual=await f.acq.importFile({url:exactUrl,title:'人工副本',origin:'manual'});expect(manual.status).toMatch(/^completed/);expect(f.acq.records.get(manual.taskId)?.selection).toBeUndefined();
  });
  it.each(['pending','failed'] as const)('protects a clean %s Selection receipt through 110 terminal records',async status=>{
    const f=await fixture();const result=await f.import();const template=f.acq.records.get(result.taskId)!;
    f.acq.records.update(result.taskId,t=>{t.file!.retained=false;t.selection={status,identity:'exact'};});
    for(let i=0;i<110;i++)f.acq.records.put({...template,id:randomUUID(),createdAt:Date.now()+i,updatedAt:Date.now()+i,file:undefined,intentId:undefined,selection:undefined});
    expect(f.acq.records.get(result.taskId)?.selection?.status).toBe(status);
  });
});
