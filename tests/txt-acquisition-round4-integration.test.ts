import {describe,it,expect,afterEach,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,symlinkSync,rmSync,readdirSync,existsSync} from 'node:fs';
import * as disk from 'node:fs/promises';
import {createServer} from 'node:http';import {once} from 'node:events';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {AcquisitionStaging} from '../src/txt-acquisition/staging.ts';
import {TxtAcquisition} from '../src/txt-acquisition/acquisition.ts';
import {Library} from '../src/library.ts';import {SelectionCoordinator} from '../src/selection.ts';
import {BOOKFISH_DEFAULTS} from '../src/config.ts';
import {downloadFile} from '../src/txt-acquisition/download.ts';
vi.mock('node:fs/promises',async original=>({...await original<typeof import('node:fs/promises')>()}));
const dirs:string[]=[];const cleanups:Array<()=>Promise<void>>=[];
const scratch=()=>{const d=mkdtempSync(join(tmpdir(),'bf-r4-integration-'));dirs.push(d);return d;};
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const barrier=()=>{let release!:()=>void;const promise=new Promise<void>(done=>release=done);return{promise,release};};
async function wait(check:()=>boolean){const until=Date.now()+4000;while(!check()){if(Date.now()>until)throw Error('Wait timed out');await new Promise(r=>setTimeout(r,5));}}
afterEach(async()=>{vi.restoreAllMocks();for(const cleanup of cleanups.splice(0))await cleanup();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(fetchImpl?:typeof fetch,browser=false){
  const dir=scratch(),library=new Library({dataDir:dir});library.open();let cfg={...BOOKFISH_DEFAULTS,txtAcquisitionEnabled:true,autonomousAcquisition:true,allowNetwork:true,browserBridgeEnabled:browser,browserBridgePort:0};
  let acq:TxtAcquisition;const selection=new SelectionCoordinator({library,novelFetches:{persisted:()=>undefined} as any,scheduler:{} as any,cfg:()=>cfg,timezone:'UTC',cancelExternal:id=>acq.cancelByIntentId(id),isExternalTask:id=>!!acq.records.get(id)});
  acq=new TxtAcquisition({dataDir:dir,library,cfg:()=>cfg,resolve:async()=>['93.184.216.34'],fetchImpl,onTaskCreated:task=>selection.onExternalTaskCreated(task),onImported:(task,identity)=>selection.onExternalImport(task,identity),...(browser?{browserGuard:async()=>undefined,controllerReady:()=>true}:{})});
  selection.start({pushEvent:async()=>undefined} as any);const id=randomUUID(),now=Date.now();library.updateSelection(state=>{state.intents.push({id,title:'海风',author:'小鱼',reason:'测试',status:'proposed',origin:'autonomous',createdAt:now,updatedAt:now,candidates:[],queueOnImport:true});});
  cleanups.push(async()=>{await selection.stop();await acq.stop();library.close();});
  return{dir,library,acq,selection,id,cfg,setCfg:(patch:any)=>{Object.assign(cfg,patch);selection.onConfigChanged();acq.onConfigChanged();}};
}
describe('round4 controlled raw races',()=>{
  it('serializes quota enumeration with a new same-hash publication',async()=>{
    const staging=new AcquisitionStaging(scratch());await staging.init();const bytes=Buffer.from('same trusted original'),digest=sha(bytes),source=staging.partialPath(randomUUID());writeFileSync(source,bytes);const relative=await staging.commitRaw(source,digest,'txt');
    const entered=barrier(),resume=barrier(),usage=staging.usage.bind(staging);vi.spyOn(staging,'usage').mockImplementationOnce(async()=>{entered.release();await resume.promise;return usage();});
    const cleanup=staging.enforceQuota(0,new Set());await entered.promise;
    const incoming=staging.partialPath(randomUUID());writeFileSync(incoming,bytes);let published=false;
    const commit=staging.commitRaw(incoming,digest,'txt',(_path,phase)=>{if(phase==='committed')published=true;});await new Promise(r=>setTimeout(r,20));expect(published).toBe(false);
    resume.release();await cleanup;await commit;expect(published).toBe(true);expect(readFileSync(staging.resolveInside(relative))).toEqual(bytes);const snapshot=await staging.verifiedOriginal({path:relative,sha256:digest,bytes:bytes.length});expect(readFileSync(snapshot)).toEqual(bytes);
  });
  it('serializes dropRaw with a new same-hash publication',async()=>{
    const f=fixture();await f.acq.init();const bytes=Buffer.from('shared bytes'),digest=sha(bytes),a=f.acq.staging.partialPath(randomUUID());writeFileSync(a,bytes);const relative=await f.acq.staging.commitRaw(a,digest,'txt');const entered=barrier(),resume=barrier(),remove=f.acq.staging.removeIfPresent.bind(f.acq.staging);
    vi.spyOn(f.acq.staging,'removeIfPresent').mockImplementationOnce(async path=>{entered.release();await resume.promise;await remove(path);});
    const dropping=(f.acq as any).dropRaw(relative);await entered.promise;const b=f.acq.staging.partialPath(randomUUID());writeFileSync(b,bytes);let published=false;const committing=f.acq.staging.commitRaw(b,digest,'txt',(_p,phase)=>{if(phase==='committed')published=true;});await new Promise(r=>setTimeout(r,20));expect(published).toBe(false);resume.release();await dropping;await committing;expect(readFileSync(f.acq.staging.resolveInside(relative))).toEqual(bytes);
  });
  it('commits three identical originals without overwriting bytes or losing publications',async()=>{
    const staging=new AcquisitionStaging(scratch());await staging.init();const bytes=Buffer.from('same hash across three attempts'),digest=sha(bytes),published:string[]=[];
    const results=await Promise.all([1,2,3].map(async n=>{const part=staging.partialPath(randomUUID());writeFileSync(part,bytes);return staging.commitRaw(part,digest,'txt',(_p,phase)=>{if(phase==='committed')published.push(String(n));});}));expect(new Set(results).size).toBe(1);expect(published).toHaveLength(3);expect(readdirSync(staging.workDir)).toHaveLength(0);expect(readFileSync(staging.resolveInside(results[0]))).toEqual(bytes);
  });
  it('refuses a directory replacement after asynchronous enumeration',async()=>{
    const base=scratch(),staging=new AcquisitionStaging(join(base,'area'));await staging.init();const name=randomUUID()+'.verified.txt';writeFileSync(join(staging.workDir,name),'owned');const outside=join(base,'outside');mkdirSync(outside);writeFileSync(join(outside,name),'external sentinel');const read=disk.readdir;
    vi.spyOn(disk,'readdir').mockImplementationOnce((async(path:any)=>{const result=await read(path);renameSync(staging.workDir,staging.workDir+'.old');symlinkSync(outside,staging.workDir,process.platform==='win32'?'junction':'dir');return result;}) as any);
    await expect(staging.clearAbandonedPrepared()).rejects.toThrow();expect(readFileSync(join(outside,name),'utf8')).toBe('external sentinel');
  });
});
describe('round4 authenticated consumed bytes',()=>{
  it('preserves an already committed unread book when cancellation arrives before the shelf receipt',async()=>{
    const f=fixture((async()=>new Response('她打开信封，读起那封迟来的信。'.repeat(100))) as typeof fetch);await f.acq.init();
    const original=f.library.importFileBestEffort.bind(f.library);
    vi.spyOn(f.library,'importFileBestEffort').mockImplementationOnce((...args)=>{const result=original(...args);f.selection.cancel(f.id);return result;});
    const result=await f.acq.importFile({url:'https://books.example/a.txt',title:'海风',author:'小鱼',intentId:f.id,origin:'autonomous'});
    expect(result.status).not.toMatch(/^completed/);expect(f.library.list()).toHaveLength(1);expect(f.library.list()[0].confirmedChars).toBe(0);
    expect(f.library.selection().intents[0].status).toBe('cancelled');expect(f.library.selection().queue).toHaveLength(0);
  });
  it('refuses a canonical-file replacement before the actual index consumes it',async()=>{
    const f=fixture((async()=>new Response('她打开信封，读起那封迟来的信。'.repeat(100))) as typeof fetch);await f.acq.init();const original=f.library.importFileBestEffort.bind(f.library);
    vi.spyOn(f.library,'importFileBestEffort').mockImplementationOnce((metadata,file,options)=>{writeFileSync(options!.decoded!.canonicalFile!,'她收到一封内容不同的信。'.repeat(100));return original(metadata,file,options);});
    const result=await f.acq.importFile({url:'https://books.example/a.txt',title:'海风'});expect(result.failure?.code).toBe('original_integrity');expect(f.library.list()).toHaveLength(0);expect(result.file?.retained).toBe(true);
  });
  it.each(['replace','remove'] as const)('rejects snapshot %s between verification and decoder open',async mutation=>{
    const prose='她打开信封，读起那封迟来的信。'.repeat(100);const f=fixture((async()=>new Response(prose)) as typeof fetch);await f.acq.init();const fail=vi.spyOn(f.library,'importFileBestEffort').mockImplementationOnce(()=>{throw Error('retry fixture');});const first=await f.acq.importFile({url:'https://books.example/a.txt',title:'海风',author:'小鱼'});fail.mockRestore();const recorded=f.acq.records.get(first.taskId)!.file!.sha256,verify=f.acq.staging.verifiedOriginal.bind(f.acq.staging);
    vi.spyOn(f.acq.staging,'verifiedOriginal').mockImplementationOnce(async input=>{const snapshot=await verify(input);if(mutation==='replace'){const altered=readFileSync(snapshot);altered[0]^=1;renameSync(snapshot,snapshot+'.old');writeFileSync(snapshot,altered);}else rmSync(snapshot);return snapshot;});
    const result=await f.acq.retry(first.taskId);expect(result.status).not.toMatch(/^completed/);expect(f.library.list()).toHaveLength(0);expect(f.acq.records.get(first.taskId)!.file!.sha256).toBe(recorded);expect(existsSync(f.acq.staging.resolveInside(f.acq.records.get(first.taskId)!.file!.path!))).toBe(true);
  });
});
describe('round4 standalone Node permission revocation',()=>{
  it.each(['silent-body','pending-headers'] as const)('aborts %s without waiting for another data chunk',async mode=>{
    let started=false,closed=false,allowed=true;const server=createServer((_req,res)=>{started=true;res.on('close',()=>closed=true);if(mode==='silent-body'){res.writeHead(200,{'content-type':'text/plain'});res.write('第一章\n');}});server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as any).port,staging=new AcquisitionStaging(scratch());await staging.init();
    const download=downloadFile({url:'https://books.example/a.txt',taskId:randomUUID(),allowNetwork:true,networkAllowed:()=>allowed,staging,resolve:async()=>['93.184.216.34'],fetchImpl:(async(_u,options)=>fetch('http://127.0.0.1:'+port,options)) as typeof fetch});const outcome=download.then(()=>undefined,error=>error);
    try{await wait(()=>started);allowed=false;expect((await outcome)?.code).toBe('policy_blocked');await wait(()=>closed);expect(readdirSync(staging.workDir)).toHaveLength(0);}finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
  });
  it.each(['last-chunk','redirect'] as const)('checks permission at %s before committing bytes',async stage=>{
    const staging=new AcquisitionStaging(scratch());await staging.init();let allowed=true,calls=0;
    const downloading=downloadFile({url:'https://books.example/a.txt',taskId:randomUUID(),allowNetwork:true,networkAllowed:()=>allowed,staging,resolve:async()=>['93.184.216.34'],onProgress:()=>{if(stage==='last-chunk')allowed=false;},fetchImpl:(async()=>{calls++;if(stage==='redirect'){allowed=false;return new Response(null,{status:302,headers:{location:'https://other.example/a.txt'}});}return new Response('她打开信封。'.repeat(100));}) as typeof fetch});
    await expect(downloading).rejects.toMatchObject({code:'policy_blocked'});expect(calls).toBe(1);expect(readdirSync(staging.workDir)).toHaveLength(0);
  });
});
describe('round4 cancellation propagation with actual slow loopback HTTP',()=>{
  it.each(['cancel','abandon','autonomous-off','network-off','stop'] as const)('aborts a silent body through %s and preserves no false shelf result',async action=>{
    // Test-only transport substitutes a local controlled server; production URL policy is unchanged.
    let responseClosed=false;const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.write('第一章\n');res.on('close',()=>{responseClosed=true;});});server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as any).port;
    const f=fixture((async(_url,options)=>fetch('http://127.0.0.1:'+port,options)) as typeof fetch);await f.acq.init();const acquiring=f.acq.importFile({url:'https://books.example/novel.txt',title:'海风',author:'小鱼',intentId:f.id,origin:'autonomous'});
    try{await wait(()=>f.acq.list().some(t=>t.status==='downloading'));await wait(()=>!!f.library.selection().intents[0].acquisitionTaskId);await new Promise(r=>setTimeout(r,30));
      if(action==='cancel')f.selection.cancel(f.id);else if(action==='abandon')f.selection.abandon(f.id);else if(action==='stop'){await f.selection.stop();await f.acq.stop();}else f.setCfg(action==='network-off'?{allowNetwork:false}:{autonomousAcquisition:false});
      const result=await acquiring;await wait(()=>responseClosed);expect(result.status).not.toMatch(/^completed/);expect(readdirSync(f.acq.staging.workDir).filter(n=>n.endsWith('.part'))).toHaveLength(0);expect(f.library.list()).toHaveLength(0);expect(f.library.selection().queue).toHaveLength(0);
    }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it('revokes a browser lease after Selection cancellation without using a production guard stub',async()=>{
    const f=fixture(undefined,true);await f.acq.init();const {port,token}=f.acq.bridgeInfo,auth={'x-bookfish-token':token,'x-bookfish-consumer':'round4-test-only'};await fetch(`http://127.0.0.1:${port}/bridge/hello`,{headers:auth});const acquiring=f.acq.importFile({url:'https://books.example/novel.txt',title:'海风',intentId:f.id,origin:'autonomous'});const polled=await fetch(`http://127.0.0.1:${port}/bridge/jobs`,{headers:auth});const {job}=await polled.json() as any;expect(job).toBeTruthy();f.selection.cancel(f.id);const heartbeat=await fetch(`http://127.0.0.1:${port}/bridge/jobs/${job.id}/heartbeat`,{method:'POST',headers:{...auth,'x-bookfish-lease':job.lease},body:'{}'});expect(heartbeat.ok).toBe(false);expect((await acquiring).status).not.toMatch(/^completed/);expect(f.library.list()).toHaveLength(0);
  });
});
