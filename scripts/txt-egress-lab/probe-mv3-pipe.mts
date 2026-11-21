import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { writeFileSync } from 'node:fs';
const root=resolve('_verify/wfp'),id=Date.now(),manifest=join(root,`mv3-probe-filters-${id}.txt`),exe=join(root,'browser/chrome.exe'),helper=join(root,'WfpLabDual.exe');
const server=createServer((_q,r)=>r.end('lab'));await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));const port=(server.address() as {port:number}).port;
let child:ReturnType<typeof spawn>|undefined,installed=false;const records:any[]=[];
try{
 execFileSync(helper,['install',manifest,String(port),exe],{windowsHide:true});installed=true;
 child=spawn(exe,['--headless','--no-first-run','--disable-background-networking','--disable-component-update','--disable-sync','--disable-component-extensions-with-background-pages','--remote-debugging-pipe','--enable-unsafe-extension-debugging',`--user-data-dir=${join(root,'mv3-probe-profile-'+id)}`,'about:blank'],{windowsHide:true,stdio:['ignore','pipe','pipe','pipe','pipe']});
 let serial=0,buffer=Buffer.alloc(0);const pending=new Map<number,{ok:(v:any)=>void,no:(e:any)=>void,t:NodeJS.Timeout}>();
 const input=child.stdio[4] as NodeJS.ReadableStream,output=child.stdio[3] as NodeJS.WritableStream;
 input.on('data',(chunk:Buffer)=>{buffer=Buffer.concat([buffer,chunk]);let end;while((end=buffer.indexOf(0))>=0){const frame=buffer.subarray(0,end).toString();buffer=buffer.subarray(end+1);if(!frame)continue;const v=JSON.parse(frame);if(v.id){const p=pending.get(v.id);if(p){clearTimeout(p.t);pending.delete(v.id);v.error?p.no(new Error(JSON.stringify(v.error))):p.ok(v.result);}}}});
 const send=(method:string,params:any={},sessionId?:string)=>new Promise<any>((ok,no)=>{const id=++serial;pending.set(id,{ok,no,t:setTimeout(()=>{pending.delete(id);no(new Error('CDP timeout '+method));},12000)});output.write(JSON.stringify({id,method,params,sessionId})+'\0');});
 const version=await send('Browser.getVersion');records.push({kind:'version',version});console.log('CDP_PIPE_READY');
 const loaded=await send('Extensions.loadUnpacked',{path:resolve('extension')});records.push({kind:'actual-MV3-load',...loaded});console.log(JSON.stringify({kind:'actual-MV3-load',...loaded}));
 await send('Target.createTarget',{url:'chrome-extension://'+loaded.id+'/popup.html'});
 await new Promise(ok=>setTimeout(ok,1500));
 const targets=await send('Target.getTargets');records.push({kind:'targets',targets});console.log(JSON.stringify(targets));
 const target=targets.targetInfos.find((t:any)=>t.url==='chrome-extension://'+loaded.id+'/popup.html');
 const session=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
 const permission=await send('Runtime.evaluate',{expression:"JSON.stringify({runtime:!!chrome.runtime,body:document.body.innerText.slice(0,100)})",awaitPromise:true,returnByValue:true,userGesture:true},session.sessionId);
 records.push({kind:'permission',permission});console.log(JSON.stringify(permission));
 const management=await send('Target.createTarget',{url:'chrome://extensions/'}); await new Promise(ok=>setTimeout(ok,500));
 const managementSession=await send('Target.attachToTarget',{targetId:management.targetId,flatten:true});
 const grant=await send('Runtime.evaluate',{expression:'(async()=>{try {await chrome.developerPrivate.addHostPermission('+JSON.stringify(loaded.id)+',"https://raw.githubusercontent.com/*");return "granted";}catch(e){return String(e);}})()',awaitPromise:true,returnByValue:true},managementSession.sessionId); records.push({kind:'isolated-management-grant',grant});console.log(JSON.stringify(grant));
 await new Promise(ok=>setTimeout(ok,1000));
 const check=await send('Runtime.evaluate',{expression:'chrome.permissions.getAll()',awaitPromise:true,returnByValue:true},session.sessionId); records.push({kind:'permissions-after',check});console.log(JSON.stringify(check));
 const consent=await send('Runtime.evaluate',{expression:'chrome.permissions.request({origins:["https://raw.githubusercontent.com/*"]})',awaitPromise:true,returnByValue:true,userGesture:true},session.sessionId);console.log('CONSENT',JSON.stringify(consent));records.push({kind:'consent-after-management',consent});
}catch(error){records.push({kind:'failure',message:String(error)});console.error(String(error));process.exitCode=1;}
finally{if(child?.pid){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});}catch{}}await new Promise(ok=>setTimeout(ok,500));if(installed){execFileSync(helper,['remove',manifest],{windowsHide:true});try{execFileSync(helper,['verify',manifest],{windowsHide:true});throw Error('filters remain');}catch(e){records.push({kind:'cleanup-query',stdout:(e as any).stdout?.toString()});}}await new Promise<void>(ok=>server.close(()=>ok()));writeFileSync(join(root,'results',`mv3-probe-${id}.json`),JSON.stringify(records,null,2));}
