/** Exact production PageSession interception under WFP, using only disposable local fixtures. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join,resolve } from 'node:path';
import { readFile,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { BrowserClient } from '../../src/txt-acquisition/browser-client.ts';
const root=resolve('_verify/wfp'),id=Date.now().toString(),profile=join(root,`cdp-profile-${id}`),manifest=join(root,`cdp-filters-${id}.txt`),browser=join(root,'browser/chrome.exe'),helper=join(root,'WfpLab.exe');
const records:unknown[]=[];const record=(value:unknown)=>{records.push(value);console.log(JSON.stringify(value));};
const run=(exe:string,args:string[])=>new Promise<{code:number|null;stdout:string}>((ok,no)=>{const p=spawn(exe,args,{windowsHide:true});let stdout='';p.stdout.on('data',s=>stdout+=s);p.stderr.on('data',s=>stdout+=s);p.on('error',no);p.on('close',code=>ok({code,stdout}));});
const listen=async(server:ReturnType<typeof createServer>)=>{await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));return(server.address() as {port:number}).port;};
let forbiddenConnections=0,childRequests=0;const sockets=new Set<import('node:net').Socket>();
const forbidden=createServer((_req,res)=>res.end('forbidden'));forbidden.on('connection',s=>{forbiddenConnections++;sockets.add(s);s.on('close',()=>sockets.delete(s));});const badPort=await listen(forbidden);
const fixture=createServer((req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');if(req.url==='/redirect'){res.writeHead(302,{location:`http://127.0.0.1:${badPort}/`});res.end();}else if(req.url==='/large'){res.setHeader('content-length',String(8*1024*1024+1));res.end(Buffer.alloc(8*1024*1024+1,120));}else if(req.url==='/child'){childRequests++;res.end('child');}else res.end(`<html><body>允许的正文<img src="http://127.0.0.1:${badPort}/image"><iframe src="/child"></iframe><script>fetch('http://127.0.0.1:${badPort}/script')</script></body></html>`);});fixture.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});const port=await listen(fixture);
let installed=false,client:BrowserClient|undefined,process:ReturnType<typeof spawn>|undefined;
try{
 const setup=await run(helper,['install',manifest,String(port),browser]);assert.equal(setup.code,0);installed=true;record({kind:'wfp-install',...setup});
 process=spawn(browser,['--headless','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--no-proxy-server','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
 let debugPort=0;for(let n=0;n<100;n++){try{debugPort=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);if(debugPort)break;}catch{}await new Promise(ok=>setTimeout(ok,50));}assert.ok(debugPort);
 client=new BrowserClient(debugPort);const page=await client.createPage();await page.protectNavigation(`http://127.0.0.1:${port}/normal`);await page.navigate(`http://127.0.0.1:${port}/normal`,2000);const body=await page.evaluate<string>('document.body.textContent');assert.ok(body.includes('允许的正文'));await page.close();
 for(const route of ['redirect','large']){const page=await client.createPage();await page.protectNavigation(`http://127.0.0.1:${port}/${route}`);let blocked=false;try{await page.navigate(`http://127.0.0.1:${port}/${route}`,500);}catch{blocked=true;}assert.ok(blocked,route+' not blocked');record({kind:'cdp-document-blocked',route});await page.close();}
 assert.equal(forbiddenConnections,0);assert.equal(childRequests,0);record({kind:'actual-production-cdp-policy',passed:true,normalDocumentRead:true,forbiddenConnections,childRequests,scriptExecution:'disabled',scope:'real Chrome + production PageSession + WFP; local fixtures, not MV3 or Coopanion'});
}catch(error){record({kind:'result',passed:false,error:String(error)});globalThis.process.exitCode=1;}
finally{await client?.disconnect();if(process?.pid)await run('taskkill',['/PID',String(process.pid),'/T','/F']);for(const socket of sockets)socket.destroy();await new Promise<void>(ok=>fixture.close(()=>ok()));await new Promise<void>(ok=>forbidden.close(()=>ok()));if(installed){record({kind:'cleanup',...await run(helper,['remove',manifest])});record({kind:'post-cleanup-filter-query',...await run(helper,['verify',manifest])});}await writeFile(join(root,'results',`cdp-${id}.json`),JSON.stringify(records,null,2));}
