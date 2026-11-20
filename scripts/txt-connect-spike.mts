/** CONNECT feasibility spike: local temporary listener, no browser or system changes. */
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {connect, type Socket} from 'node:net';
import {connect as tlsConnect} from 'node:tls';
import {lookup} from 'node:dns/promises';
import {randomBytes} from 'node:crypto';
import {checkUrl} from '../src/txt-acquisition/url-policy.ts';
const token=randomBytes(24).toString('hex');
const sockets=new Set<Socket>();
let dials=0;
const proxy=createServer((_req,res)=>{res.writeHead(405);res.end();});
proxy.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});
proxy.on('connect',(req,client,head)=>{void (async()=>{
 try {
  if(req.headers['proxy-authorization']!==`Bearer ${token}`)throw new Error('auth');
  if(head.length)throw new Error('early data');
  const raw=`https://${req.url}/`;
  let selected:{address:string;family:number}|undefined;
  const url=await checkUrl(raw,{allowNetwork:true,resolve:async host=>{
   const records=await lookup(host,{all:true,verbatim:true});selected=records[0];return records.map(r=>r.address);
  }});
  if((url.port||'443')!=='443')throw new Error('port');
  // Probe deliberately allows only one public destination, no general-purpose proxy.
  if(url.hostname!=='example.com'||!selected)throw new Error('scope');
  const pinned=selected;
  const upstream=connect({host:pinned.address,port:443,family:pinned.family});dials++;
  sockets.add(upstream);upstream.once('close',()=>sockets.delete(upstream));
  upstream.setTimeout(15000,()=>upstream.destroy());
  upstream.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');upstream.pipe(client);client.pipe(upstream);});
  upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.once('close',()=>upstream.destroy());
 }catch{client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');}
})();});
await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const port=(proxy.address() as {port:number}).port;
async function tunnel(authority:string,authorized=true):Promise<{status:number;socket:Socket;head:Buffer}>{
 return new Promise((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port,method:'CONNECT',path:authority,headers:authorized?{'proxy-authorization':`Bearer ${token}`}:{},agent:false,signal:AbortSignal.timeout(20000)});
  req.on('connect',(res,socket,head)=>resolve({status:res.statusCode!,socket,head}));req.on('error',reject);req.end();
 });
}
try {
 for(const target of ['127.0.0.1:443','169.254.169.254:443','[::1]:443','example.com:8443']){
  const before=dials;const denied=await tunnel(target);assert.equal(denied.status,403);denied.socket.destroy();assert.equal(dials,before);
 }
 const noAuth=await tunnel('example.com:443',false);assert.equal(noAuth.status,403);noAuth.socket.destroy();assert.equal(dials,0);
 console.log(JSON.stringify({kind:'real-loopback-proxy-negative',passed:5,targetDials:0,scope:'private literals, metadata, port and missing auth only; no browser'}));
 const result=await tunnel('example.com:443');assert.equal(result.status,200);assert.equal(result.head.length,0);
 await new Promise<void>((resolve,reject)=>{
  const tls=tlsConnect({socket:result.socket,servername:'example.com',rejectUnauthorized:true});
  tls.setTimeout(15000,()=>tls.destroy(new Error('TLS timeout')));let bytes=0;let prefix='';
  tls.once('secureConnect',()=>{assert.equal(tls.authorized,true);tls.write('GET / HTTP/1.1\r\nHost: example.com\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n');});
  tls.on('data',chunk=>{bytes+=chunk.length;if(prefix.length<128)prefix+=chunk.toString('ascii').slice(0,128-prefix.length);if(bytes>8192)tls.destroy(new Error('body limit'));});
  tls.on('error',reject);tls.on('end',()=>{assert.match(prefix,/^HTTP\/1\.[01] 200/u);console.log(JSON.stringify({kind:'real-connect-tls',status:200,certificateAuthorized:true,targetDials:dials,bytes,tlsTerminatedBy:'client; proxy forwards encrypted bytes'}));resolve();});
 });
}finally{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>proxy.close(()=>resolve()));}
