/** Controlled Chrome public-file transport integration. Not a BookFish acceptance test. */
import {createServer,request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {connect,type Socket} from 'node:net';
import {lookup} from 'node:dns/promises';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {checkUrl} from '../../src/txt-acquisition/url-policy.ts';
const root=resolve('_verify/wfp');const id=Date.now().toString();
const helper=join(root,'WfpLab.exe'),browser=join(root,'browser/chrome.exe'),manifest=join(root,`public-filters-${id}.txt`);
const source='https://www.rfc-editor.org/rfc/rfc1149.txt';
const records:unknown[]=[];function record(value:unknown){records.push(value);console.log(JSON.stringify(value));}
function run(exe:string,args:string[],timeout=25000):Promise<{code:number|null;stdout:string;stderr:string}>{return new Promise((ok,no)=>{const child=spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>{spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});no(new Error('Child timeout'));},timeout);child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);child.on('error',e=>{clearTimeout(timer);no(e);});child.on('close',code=>{clearTimeout(timer);ok({code,stdout,stderr});});});}
const listen=async(server:ReturnType<typeof createServer>)=>{await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));return(server.address() as {port:number}).port;};
async function pinnedPlan(raw:string){let selected:{address:string;family:number}|undefined;const url=await checkUrl(raw,{allowNetwork:true,resolve:async host=>{const all=await lookup(host,{all:true,verbatim:true});selected=all.find(item=>item.family===4)??all[0];return all.map(a=>a.address);}});assert.ok(selected);return{url,pinned:selected};}
const expectedPlan=await pinnedPlan(source);
const expected=await new Promise<Buffer>((ok,no)=>{const req=httpsRequest(expectedPlan.url,{agent:false,family:expectedPlan.pinned.family,signal:AbortSignal.timeout(15000),lookup:(_host,options,cb)=>options.all?cb(null,[expectedPlan.pinned]):cb(null,expectedPlan.pinned.address,expectedPlan.pinned.family),headers:{'accept-encoding':'identity'}},res=>{if(res.statusCode!==200){res.resume();no(new Error('Reference HTTP '+res.statusCode));return;}const pieces:Buffer[]=[];let bytes=0;res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>1024*1024)res.destroy(new Error('reference limit'));else pieces.push(chunk);});res.on('end',()=>ok(Buffer.concat(pieces)));res.on('error',no);});req.on('error',no);req.end();});
const expectedHash=createHash('sha256').update(expected).digest('hex');record({kind:'independent-reference',bytes:expected.length,sha256:expectedHash,sourceHost:expectedPlan.url.hostname});
let targetConnections=0;const target=createServer((_req,res)=>res.end('controlled-target'));
target.on('connection',()=>targetConnections++);const targetPort=await listen(target);
const sockets=new Set<Socket>();const tunnels:Socket[]=[];let connectCount=0,blockedConnects=0;let reportBody:any;let releaseHold:(()=>void)|undefined;
const proxy=createServer((req,res)=>{
 let path:string;try{const url=new URL(req.url??'/',`http://127.0.0.1:${proxyPort}`);if(url.hostname!=='127.0.0.1'||Number(url.port)!==proxyPort){res.writeHead(403);res.end();return;}path=url.pathname;}catch{res.writeHead(400);res.end();return;}
 if(path==='/hold'){releaseHold=()=>res.end('done');setTimeout(()=>releaseHold?.(),12000).unref();return;}
 if(path==='/report'){let body='';req.on('data',s=>{body+=s;if(body.length>8192)req.destroy();});req.on('end',()=>{try{reportBody=JSON.parse(body);}catch{reportBody={error:'bad report'};}res.end('ok');releaseHold?.();});return;}
 if(path==='/file-test'){
 res.setHeader('content-type','text/html');res.end(`<!doctype html><body><img src="/hold"><pre id="result">running</pre><script>(async()=>{let result;try{const response=await fetch(${JSON.stringify(source)},{redirect:'error',credentials:'omit',cache:'no-store'});if(!response.ok)throw Error('HTTP '+response.status);const bytes=new Uint8Array(await response.arrayBuffer());const digest=await crypto.subtle.digest('SHA-256',bytes);result={status:response.status,bytes:bytes.length,sha256:Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('')};}catch(e){result={error:e.name};}document.getElementById('result').textContent=JSON.stringify(result);await fetch('/report',{method:'POST',body:JSON.stringify(result)});})();</script></body>`);return;
 }
 res.writeHead(404);res.end();
});
proxy.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});
proxy.on('connect',(req,client,head)=>{void(async()=>{try{
 if(head.length)throw Error('early bytes');const authority=new URL(`https://${req.url}/`);
 if(authority.hostname!=='www.rfc-editor.org'||(authority.port||'443')!=='443'||authority.username||authority.password)throw Error('scope');
 const {pinned}=await pinnedPlan(authority.href);
 const upstream=connect({host:pinned.address,port:443,family:pinned.family});connectCount++;tunnels.push(upstream);sockets.add(upstream);upstream.once('close',()=>sockets.delete(upstream));
 upstream.setTimeout(20000,()=>upstream.destroy());upstream.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');client.pipe(upstream);upstream.pipe(client);});upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.once('close',()=>upstream.destroy());
 }catch{blockedConnects++;client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');}})();});
const proxyPort=await listen(proxy);
const common=['--headless','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--metrics-recording-only','--disable-crash-reporter','--dump-dom'];
async function chrome(label:string,url:string,proxied:boolean){const result=await run(browser,[...common,`--user-data-dir=${join(root,`public-profile-${id}-${label}`)}`,...(proxied?[`--proxy-server=http://127.0.0.1:${proxyPort}`,'--proxy-bypass-list=<-loopback>']:['--no-proxy-server']),url]);await writeFile(join(root,`public-${id}-${label}.stdout`),result.stdout);await writeFile(join(root,`public-${id}-${label}.stderr`),result.stderr);record({kind:'browser',label,exit:result.code});return result;}
let installed=false,proxyClosed=false;
try{
 await chrome('target-positive',`http://127.0.0.1:${targetPort}/`,false);assert.ok(targetConnections>0);record({kind:'target-positive-control',connections:targetConnections});
 const setup=await run(helper,['install',manifest,String(proxyPort),browser]);assert.equal(setup.code,0);installed=true;record({kind:'wfp-install',...setup});
 const result=await chrome('public-txt',`http://127.0.0.1:${proxyPort}/file-test`,true);
 assert.equal(result.code,0);assert.ok(reportBody&&!reportBody.error,JSON.stringify(reportBody));assert.equal(reportBody.bytes,expected.length);assert.equal(reportBody.sha256,expectedHash);assert.ok(connectCount>0);
 record({kind:'real-browser-public-file',...reportBody,bytesMatch:true,hashMatches:true,connectCount,blockedOtherConnects:blockedConnects,tls:'browser validates upstream certificate; no local CA or TLS interception'});
 // Same protected browser, but no proxy configuration: public fetch must fail.
 reportBody=undefined;releaseHold=undefined;await chrome('public-direct-denied',`http://127.0.0.1:${proxyPort}/file-test`,false);assert.ok(reportBody?.error);record({kind:'browser-public-direct-fails',error:reportBody.error});
 for(const socket of sockets)socket.destroy();await new Promise<void>(ok=>proxy.close(()=>ok()));proxyClosed=true;
 const before=targetConnections;await chrome('proxy-stopped',`http://127.0.0.1:${targetPort}/`,true);assert.equal(targetConnections,before);record({kind:'proxy-stopped-target-delta',connections:targetConnections-before});
 record({kind:'result',passed:true,scope:'controlled Chrome fixed-IP CONNECT/public TXT byte identity/direct failure/stopped-proxy; not extension or Coopanion'});
}catch(error){record({kind:'result',passed:false,error:String(error)});process.exitCode=1;}
finally{
 for(const socket of sockets)socket.destroy();if(!proxyClosed)await new Promise<void>(ok=>proxy.close(()=>ok()));await new Promise<void>(ok=>target.close(()=>ok()));
 if(installed){const cleanup=await run(helper,['remove',manifest]);record({kind:'cleanup',...cleanup});if(cleanup.code!==0)process.exitCode=1;record({kind:'post-cleanup-filter-query',...await run(helper,['verify',manifest])});}
 await writeFile(join(root,'results',`public-${id}.json`),JSON.stringify(records,null,2));
}
