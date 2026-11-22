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
  const events:any[]=[];const host={pushEvent:async(e:any)=>{events.push(JSON.parse(e.text));}};make();await acq.init();selection.start(host as any);
  const id=randomUUID(),now=Date.now();library.updateSelection(s=>{s.intents.push({id,title:'海风',author:'小鱼',reason:'测试',status:'proposed',origin:'autonomous',createdAt:now,updatedAt:now,candidates:[],queueOnImport:true});});
  cleanup.push(async()=>{await selection.stop();await acq.stop();library.close();rmSync(dir,{recursive:true,force:true});});
  return{events,get library(){return library;},get selection(){return selection;},get acq(){return acq;},cfg,id,
    intent:()=>library.selection().intents.find(i=>i.id===id)!,
    import:(url=exactUrl)=>acq.importFile({url,title:'海风',author:'小鱼',intentId:id,origin:'autonomous'}),
    restart:async()=>{await selection.stop();await acq.stop();library.close();library=new Library({dataDir:dir});library.open();make();await acq.init();selection.start(host as any);await acq.resumeSelection();}};
}

describe('final source display identity',()=>{
  it.each([
    ['《另一部》作者：小鱼.txt','另一部','小鱼','partial'],
    ['《海风》作者：另一作者.txt','海风','另一作者','partial'],
    ['《海风》.txt','海风','','partial'],
    ['novel.txt',null,'','unknown'],
    ['《海风》作者：小鱼.txt','海风','小鱼','exact'],
    ['《海风（修订版）》作者：小鱼.txt','海风（修订版）','小鱼','partial'],
  ])('uses declared display identity %s',async(filename,title,author,identity)=>{
    const f=await fixture();const done=await f.import('https://books.example/'+encodeURIComponent(filename));
    expect(done.status).toMatch(/^completed/);const book=f.library.list()[0];
    if(title)expect(book.title).toBe(title);else expect(book.title).toMatch(/^未确认作品.*[a-f0-9]{12}/);
    expect(book.author).toBe(author);expect(book.confirmedChars).toBe(0);expect(f.acq.records.get(done.taskId)?.selection?.identity).toBe(identity);
    expect(f.library.selection().queue).toHaveLength(identity==='exact'?1:0);expect(done.target).toEqual({title:'海风',author:'小鱼'});
    const status=f.selection.summary(f.id).intent as any;expect(status.txtIdentity.wantedIdentity).toEqual({title:'海风',author:'小鱼'});
    expect(status.txtIdentity.libraryDisplayIdentity).toEqual({title:book.title,author:book.author});
    expect(JSON.stringify(status.txtIdentity)).not.toMatch(/https:|token|cookie/i);
  });
  it('does not merge two generic files or corrupt an existing wanted book and progress',async()=>{
    let calls=0;const f=await fixture({fetchImpl:async()=>new Response(body+(++calls===1?'甲':'乙'))});
    const old=f.library.import({filename:'old.txt',title:'海风',author:'小鱼',base64:Buffer.from(body).toString('base64')});
    f.library.select(old.book.key);const reading=f.library.readNext();if(reading.complete)throw Error('fixture needs unread text');
    f.library.finish({taskId:reading.taskId,bookKey:reading.bookKey,segmentId:reading.segmentId,understanding:'合成旧书进度夹具，不是用户阅读数据。'});
    const snapshot=JSON.stringify(f.library.list());expect(f.library.list()[0].confirmedChars).toBeGreaterThan(0);
    await f.acq.importFile({url:'https://books.example/novel.txt',title:'海风',author:'小鱼',origin:'manual'});
    await f.acq.importFile({url:'https://books.example/novel.txt',title:'海风',author:'小鱼',origin:'manual'});
    const books=f.library.list();expect(books).toHaveLength(3);expect(new Set(books.map(b=>b.id)).size).toBe(3);
    expect(JSON.stringify(books.filter(b=>b.key===old.book.key))).toBe(snapshot);expect(f.library.selection().queue).toHaveLength(0);
  });
  it('retains stable display metadata and original through retry and two restarts',async()=>{
    const f=await fixture();const fault=vi.spyOn(f.library,'importFileBestEffort').mockImplementationOnce(()=>{throw Error('disk temporary');});
    const first=await f.import('https://books.example/novel.txt');fault.mockRestore();const done=await f.acq.retry(first.taskId);
    const key=done.bookKey,sha=done.file?.sha256;await f.restart();await f.restart();const retried=await f.acq.retry(done.taskId);
    expect(retried.bookKey).toBe(key);expect(retried.file?.sha256).toBe(sha);expect(f.library.list()).toHaveLength(1);expect(f.library.selection().queue).toHaveLength(0);
  });
});
describe('final awaiting choice guidance',()=>{
  it('keeps search guidance separate and fails closed for unknown or contradictory stage',async()=>{
    const f=await fixture();const base={...f.intent(),status:'awaiting_choice',candidates:[{id:'one'},{id:'two'}]};
    (f.selection as any).announce(base,'awaiting_choice','search');expect(f.events.at(-1).guidance).toContain('candidate');expect(f.events.at(-1).guidance).not.toContain('planAction');
    f.library.updateSelection(s=>{delete s.intents[0].notified;});
    (f.selection as any).announce({...base,candidates:[]},'awaiting_choice','unknown');expect(f.events.at(-1).guidance).toMatch(/diagnostic|unavailable|unclear/i);expect(f.events.at(-1).guidance).not.toContain('action="start"');
    f.library.updateSelection(s=>{delete s.intents[0].notified;});
    (f.selection as any).announce({...base,bookKey:'wrong',failure:{code:'identity_mismatch'}},'awaiting_choice','search');expect(f.events.at(-1).guidance).not.toContain('action="start"');
  });
  it('announces imported unknown identity safely, survives repeated notification and reopens, then explicitly queues',async()=>{
    const f=await fixture();const done=await f.import('https://books.example/novel.txt');
    const event=f.events.find(e=>e.status==='awaiting_choice');expect(event.stage).toBe('import');expect(event.acquisitionTaskId).toBe(done.taskId);expect(event.bookKey).toBe(done.bookKey);
    expect(event.guidance).toContain('身份信息不足');expect(event.guidance).toContain('planAction="queue"');expect(event.guidance).toContain('abandon');expect(event.guidance).not.toContain('action="start"');
    expect(event.txtIdentity.declaredIdentity).toEqual({});expect(f.library.selection().queue).toHaveLength(0);
    (f.selection as any).announce(f.intent(),'awaiting_choice','import');await f.restart();await f.restart();
    f.library.updateSelection(s=>{delete s.intents[0].notified;});(f.selection as any).announce(f.intent(),'awaiting_choice','import');expect(f.events.at(-1).guidance).toContain('planAction="queue"');
    f.selection.plan(f.id,'queue');f.selection.plan(f.id,'queue');expect(f.library.selection().queue).toHaveLength(1);expect(f.library.list()[0].confirmedChars).toBe(0);
  });
  it.each(['abandoned','cancelled','deferred'])('guidance cannot revive %s and never deletes the shelf',async status=>{
    const f=await fixture();await f.import('https://books.example/novel.txt');f.library.updateSelection(s=>{s.intents[0].status=status as any;});
    (f.selection as any).announce(f.intent(),'awaiting_choice','import');expect(f.intent().status).toBe(status);expect(f.library.selection().queue).toHaveLength(0);expect(f.library.list()).toHaveLength(1);
  });
  it('abandon retains the imported book and ends the intent without queueing',async()=>{
    const f=await fixture();await f.import('https://books.example/novel.txt');f.selection.abandon(f.id,'pet');expect(f.intent().status).toBe('abandoned');expect(f.library.list()).toHaveLength(1);expect(f.library.selection().queue).toHaveLength(0);
  });
});
describe('final terminal retry boundary investigation',()=>{
  it.each(['retry','repair'] as const)('cannot reactivate an autonomous terminal failure via %s',async action=>{
    const fetcher=vi.fn(async()=>new Response(Buffer.alloc(4096)));const f=await fixture({fetchImpl:fetcher});const failed=await f.import();expect(failed.status).toBe('failed_terminal');expect(f.intent().status).toBe('failed');
    const importSpy=vi.spyOn(f.library,'importFileBestEffort');await f.acq[action](failed.taskId);expect(fetcher).toHaveBeenCalledTimes(1);expect(importSpy).not.toHaveBeenCalled();expect(f.intent().status).toBe('failed');expect(f.library.selection().queue).toHaveLength(0);
  });
});
