/** Real Chrome + target-side TCP/UDP canaries; WFP only matches lab copies. */
import {createServer} from 'node:http';
import {createSocket} from 'node:dgram';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {networkInterfaces} from 'node:os';
import assert from 'node:assert/strict';
const root=resolve('_verify/wfp');
const helper=join(root,'WfpLab.exe'),probe=join(root,'SocketProbe.exe'),browser=join(root,'browser/chrome.exe');
const runId=Date.now().toString();const manifest=join(root,`filters-${runId}.txt`);
const evidence:unknown[]=[];
const state={tcp4:0,tcp6:0,lan:0,udp4:0,udp6:0,udpAtProxy:0,proxy:0};
function record(value:unknown){evidence.push(value);console.log(JSON.stringify(value));}
function run(exe:string,args:string[],timeout=20000):Promise<{code:number|null;stdout:string;stderr:string}>{
 return new Promise((resolveRun,reject)=>{
  const child=spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  const timer=setTimeout(()=>{void run('taskkill',['/PID',String(child.pid),'/T','/F'],5000);reject(new Error('Child timeout'));},timeout);
  child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('close',code=>{clearTimeout(timer);resolveRun({code,stdout,stderr});});
 });
}
const listen=async(server:ReturnType<typeof createServer>,host:string,port=0)=>{await new Promise<void>((ok,no)=>{server.once('error',no);server.listen(port,host,ok);});return(server.address() as {port:number}).port;};
const counts=()=>({...state});
const sockets=new Set<import('node:net').Socket>();
function canary(key:'tcp4'|'tcp6'|'lan'){
 const server=createServer((_req,res)=>{res.setHeader('access-control-allow-origin','*');res.end('canary');});
 server.on('connection',socket=>{state[key]++;sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});return server;
}
const tcp4=canary('tcp4'),tcp6=canary('tcp6'),lan=canary('lan');
const p4=await listen(tcp4,'127.0.0.1'),p6=await listen(tcp6,'::1');
const lanIp=Object.values(networkInterfaces()).flat().find(item=>item?.family==='IPv4'&&!item.internal&&!item.address.startsWith('169.254.'))?.address;
assert.ok(lanIp);const lanPort=await listen(lan,lanIp);
const udp4=createSocket('udp4'),udp6=createSocket('udp6');
udp4.on('message',()=>state.udp4++);udp6.on('message',()=>state.udp6++);
await new Promise<void>(ok=>udp4.bind(0,'127.0.0.1',ok));await new Promise<void>(ok=>udp6.bind(0,'::1',ok));
const u4=udp4.address().port,u6=udp6.address().port;
const proxy=createServer((req,res)=>{
 state.proxy++;
 if(req.url==='/hold'){setTimeout(()=>res.end('done'),4500);return;}
 if(req.url?.startsWith('/page')){
 res.setHeader('content-type','text/html');
 res.end(`<!doctype html><body>running<img src="/hold"><script>
 const results={};
 for(const [name,url] of Object.entries({tcp4:'http://127.0.0.1:${p4}/',tcp6:'http://[::1]:${p6}/',lan:'http://${lanIp}:${lanPort}/'}))fetch(url,{mode:'no-cors',cache:'no-store'}).then(()=>results[name]='reached',()=>results[name]='failed');
 const peers=[];for(const url of ['stun:127.0.0.1:${u4}','stun:[::1]:${u6}']){try{const pc=new RTCPeerConnection({iceServers:[{urls:url}]});peers.push(pc);pc.createDataChannel('probe');pc.createOffer().then(o=>pc.setLocalDescription(o)).then(()=>results[url]='attempted',e=>results[url]=e.name);}catch(e){results[url]=e.name;}}
 setInterval(()=>{let old=document.getElementById('result');if(!old){old=document.createElement('pre');old.id='result';document.body.append(old);}old.textContent=JSON.stringify(results);},100);
 </script></body>`);return;
 }
 res.end('proxy-canary');
});
const proxyPort=await listen(proxy,'127.0.0.1');
const udpAtProxy=createSocket('udp4');udpAtProxy.on('message',()=>state.udpAtProxy++);await new Promise<void>(ok=>udpAtProxy.bind(proxyPort,'127.0.0.1',ok));
const common=['--headless','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--metrics-recording-only','--disable-crash-reporter','--dump-dom'];
async function chrome(label:string,url:string,extra:string[]=[]){
 const result=await run(browser,[...common,`--user-data-dir=${join(root,`profile-${runId}-${label}`)}`,...extra,url],25000);
 await writeFile(join(root,`${runId}-${label}.stdout`),result.stdout);await writeFile(join(root,`${runId}-${label}.stderr`),result.stderr);
 record({kind:'browser',label,exit:result.code,result:result.stdout.match(/<pre id="result">(.*?)<\/pre>/su)?.[1]??null,networkAccessDenied:result.stdout.includes('ERR_NETWORK_ACCESS_DENIED')});return result;
}
let installed=false;
try{
 record({kind:'canary-endpoints',p4,p6,lanIp,lanPort,u4,u6,proxyPort,manifest});
 await chrome('baseline',`http://127.0.0.1:${proxyPort}/page`,['--no-proxy-server']);
 record({kind:'browser-baseline',counts:counts()});
 assert.ok(state.tcp4>0&&state.tcp6>0&&state.lan>0,'Browser TCP canaries must be reachable before rules');
 assert.ok(state.udp4>0&&state.udp6>0,'Browser STUN UDP4/UDP6 must reach positive canaries');
 for(const [mode,host,port] of [['tcp','127.0.0.1',p4],['tcp','::1',p6],['udp','127.0.0.1',u4],['udp','::1',u6],['udp','127.0.0.1',proxyPort]] as const){const result=await run(probe,[mode,host,String(port)]);assert.equal(result.code,0);}
 await new Promise(ok=>setTimeout(ok,200));
 const setup=await run(helper,['install',manifest,String(proxyPort),browser,probe]);record({kind:'wfp-install',...setup});assert.equal(setup.code,0);installed=true;
 // Installer has exited. Filters must still exist and enforce default deny.
 const query=await run(helper,['verify',manifest]);assert.equal(query.code,0);record({kind:'filters-after-installer-exit',...query});
 const before=counts();
 const native=[];
 for(const [mode,host,port] of [['tcp','127.0.0.1',p4],['tcp','::1',p6],['tcp',lanIp,lanPort],['udp','127.0.0.1',u4],['udp','::1',u6],['udp','127.0.0.1',proxyPort]] as const){const result=await run(probe,[mode,host,String(port)]);native.push({mode,host,port,...result});if(mode==='tcp')assert.match(result.stdout,/AccessDenied/u);}
 const allowed=await run(probe,['tcp','127.0.0.1',String(proxyPort)]);assert.equal(allowed.code,0);record({kind:'native-block-and-exact-permit',denied:native.length,allowed:allowed.stdout.trim(),details:native});
 await chrome('restricted-page',`http://127.0.0.1:${proxyPort}/page`,['--no-proxy-server']);
 await new Promise(ok=>setTimeout(ok,200));
 const after=counts();for(const key of ['tcp4','tcp6','lan','udp4','udp6','udpAtProxy'] as const)assert.equal(after[key],before[key],`${key} leaked`);
 record({kind:'restricted-browser-canary-deltas',tcp4:after.tcp4-before.tcp4,tcp6:after.tcp6-before.tcp6,lan:after.lan-before.lan,udp4:after.udp4-before.udp4,udp6:after.udp6-before.udp6,udpAtProxy:after.udpAtProxy-before.udpAtProxy,proxyRequests:after.proxy-before.proxy});
 const direct=await chrome('direct-forbidden',`http://127.0.0.1:${p4}/`,['--no-proxy-server']);assert.equal(state.tcp4,after.tcp4,'Direct top-level navigation reached forbidden target');record({kind:'direct-top-level-navigation',targetConnectionDelta:state.tcp4-after.tcp4,note:'Chrome dump-dom need not contain its internal network error code'});
 // Wrong proxy config cannot restore network. The permitted endpoint is deliberately absent.
 const stopped=await chrome('wrong-proxy',`http://${lanIp}:${lanPort}/`,['--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=<-loopback>']);
 assert.equal(state.lan,after.lan);record({kind:'wrong-proxy-no-direct-fallback',forbiddenTargetDelta:0,browserFailed:stopped.stdout.includes('ERR_')});
 // Force-kill a controller process, then prove persistent policy still blocks.
 const holder=spawn(helper,['hold',manifest],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 await new Promise<void>(ok=>holder.stdout.once('data',()=>ok()));await run('taskkill',['/PID',String(holder.pid),'/T','/F']);
 const afterKill=await run(probe,['tcp','127.0.0.1',String(p4)]);assert.match(afterKill.stdout,/AccessDenied/u);
 record({kind:'controller-killed-policy-still-blocks',probe:afterKill.stdout.trim(),filtersPresent:(await run(helper,['verify',manifest])).code===0});
 record({kind:'result',passed:true,scope:'real Chrome standalone canaries plus native WFP TCP/UDP probes; BookFish extension not yet integrated'});
}catch(error){record({kind:'result',passed:false,error:String(error)});process.exitCode=1;}
finally{
 if(installed){const cleanup=await run(helper,['remove',manifest]);record({kind:'cleanup',...cleanup});if(cleanup.code!==0)process.exitCode=1;const verify=await run(helper,['verify',manifest]);record({kind:'post-cleanup-filter-query',...verify});}
 for(const socket of sockets)socket.destroy();
 for(const server of [proxy,tcp4,tcp6,lan])await new Promise<void>(ok=>server.close(()=>ok()));udp4.close();udp6.close();udpAtProxy.close();
 await mkdir(join(root,'results'),{recursive:true});await writeFile(join(root,'results',`${runId}.json`),JSON.stringify(evidence,null,2));
}
