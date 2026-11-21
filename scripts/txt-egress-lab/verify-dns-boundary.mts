/** Windows DNS ETW diagnostic. Raw whole-session trace stays private in _verify only. */
import {execFileSync}from'node:child_process';import{createServer}from'node:http';import{join,resolve}from'node:path';import{mkdirSync,writeFileSync}from'node:fs';import{LabBrowser}from'./lab-browser.mts';
const root=resolve('_verify/wfp'),id=Date.now(),work=join(root,'dns-'+id),exe=join(root,'browser/chrome.exe'),helper=join(root,'WfpLabDual.exe'),manifest=join(root,`dns-filters-${id}.txt`),trace='BookFishDns'+id;mkdirSync(work,{recursive:true});const etl=join(work,'dns.etl');
const record=(value:any)=>{records.push(value);console.log(JSON.stringify(value));};const records:any[]=[];let browser:LabBrowser|undefined,installed=false,tracing=false;
const server=createServer((_q,r)=>{r.writeHead(403);r.end('denied');});await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));const port=(server.address()as{port:number}).port;
const domains=[`bookfish-${id}-direct.example.com`,`bookfish-${id}-blocked.example.com`];
try{
 execFileSync('logman',['start',trace,'-p','Microsoft-Windows-DNS-Client','0xFFFFFFFFFFFFFFFF','5','-o',etl,'-ets'],{windowsHide:true,stdio:'pipe'});tracing=true;record({kind:'temporary-ETW-session',provider:'Microsoft-Windows-DNS-Client',globalOperationalChannelChanged:false});
 execFileSync(helper,['install',manifest,String(port),exe],{windowsHide:true,stdio:'pipe'});installed=true;
 for(let index=0;index<domains.length;index++){
  const domain=domains[index]!;const flags=index===0?['--no-proxy-server','--disable-async-dns','--disable-features=AsyncDns,DnsOverHttps,DnsOverHttpsUpgrade']:[`--proxy-server=http://127.0.0.1:${port}`,'--proxy-bypass-list=<-loopback>','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'];
  browser=new LabBrowser(exe,['--headless','--no-first-run','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--remote-debugging-pipe',`--user-data-dir=${join(work,'profile-'+index)}`,...flags,'about:blank']);const page=await browser.page('about:blank');
  await browser.evaluate(page,`(async()=>{const pc=new RTCPeerConnection({iceServers:[{urls:'stun:${domain}:3478'}]});pc.createDataChannel('lab');await pc.setLocalDescription(await pc.createOffer());await fetch('https://${domain}/',{signal:AbortSignal.timeout(3000)}).catch(()=>{});await new Promise(ok=>setTimeout(ok,1000));pc.close();return true;})()`);
  record({kind:'browser-DNS-exercise',domain,mode:index===0?'OS-resolution-with-browser-WFP':'fixed-proxy-and-browser-host-resolver-deny',browserPid:browser.child.pid});await browser.close();browser=undefined;
 }
}catch(error){record({kind:'diagnostic-error',error:String(error)});process.exitCode=1;}
finally{await browser?.close();if(installed){execFileSync(helper,['remove',manifest],{windowsHide:true,stdio:'pipe'});try{execFileSync(helper,['verify',manifest],{windowsHide:true,stdio:'pipe'});process.exitCode=1;}catch(e){record({kind:'cleanup',stdout:(e as any).stdout?.toString()});}}if(tracing){execFileSync('logman',['stop',trace,'-ets'],{windowsHide:true,stdio:'pipe'});}
 await new Promise<void>(ok=>server.close(()=>ok()));
 writeFileSync(join(work,'domains.json'),JSON.stringify(domains));writeFileSync(join(root,'results',`dns-${id}.json`),JSON.stringify({records,privateTrace:etl,domains,note:'ETW events require filtering to these test domains. This is not a packet-capture proof that no DNS leaked.'},null,2));}
