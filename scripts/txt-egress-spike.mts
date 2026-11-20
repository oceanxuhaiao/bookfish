/** Design spike only. No production transport or browser changes. */
import assert from 'node:assert/strict';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request } from 'node:https';
import { checkUrl, isBlockedAddress } from '../src/txt-acquisition/url-policy.ts';

type Answer = { address: string; family: 4 | 6 };
async function plan(raw: string, allow: boolean, resolver: (host: string) => Promise<Answer[]>) {
  let answers: Answer[] = [];
  const url = await checkUrl(raw, {allowNetwork: allow, resolve: async host => {
    answers = await resolver(host); return answers.map(item => item.address);
  }});
  if (url.port && !['80','443'].includes(url.port)) throw new Error('Port refused');
  if (!answers.length) {
    const host = url.hostname.replace(/^\[|\]$/gu, '');
    answers = [{address:host,family:host.includes(':')?6:4}];
  }
  if (answers.some(item => isBlockedAddress(item.address))) throw new Error('Address refused');
  return {url, pinned:answers[0]!};
}
const publicAnswer: Answer = {address:'93.184.216.34',family:4};
const privateAnswer: Answer = {address:'127.0.0.1',family:4};
let checks = 0;
for (const url of ['http://127.0.0.1/a','http://169.254.169.254/a','http://[::1]/a','http://[::ffff:127.0.0.1]/a']) {
  let dialed=false;
  await assert.rejects(async()=>{ await plan(url,true,async()=>[publicAnswer]); dialed=true; });
  assert.equal(dialed,false); checks++;
}
await assert.rejects(()=>plan('https://example.test/a',true,async()=>[publicAnswer,privateAnswer])); checks++;
let disabledResolved=false;
await assert.rejects(()=>plan('https://example.test/a',false,async()=>{disabledResolved=true;return [publicAnswer];}));
assert.equal(disabledResolved,false); checks++;
await assert.rejects(()=>plan('https://example.test:8443/a',true,async()=>[publicAnswer])); checks++;
let resolutions=0;
const pinned=await plan('https://example.test/a',true,async()=>{resolutions++;return [resolutions===1?publicAnswer:privateAnswer];});
assert.equal(pinned.pinned.address,publicAnswer.address); assert.equal(resolutions,1); checks++;
console.log(JSON.stringify({kind:'controlled-design-checks',passed:checks,scope:'URL policy and one resolution plan only; not a proxy or browser acceptance test'}));

// One real public TLS request. No cookies, no authorization, no redirects followed.
try {
  let dnsCalls=0, socketLookupCalls=0;
  const real=await plan('https://example.com/',true,async host=>{
    dnsCalls++;
    return (await dnsLookup(host,{all:true,verbatim:true})).map(item=>({address:item.address,family:item.family as 4|6}));
  });
  const outcome=await new Promise<Record<string,unknown>>((resolve,reject)=>{
    const req=request(real.url,{
      agent:false, family:real.pinned.family, servername:real.url.hostname,
      rejectUnauthorized:true, signal:AbortSignal.timeout(15000),
      lookup:(_host,options,callback)=>{
        socketLookupCalls++;
        if(options.all) callback(null,[real.pinned]);
        else callback(null,real.pinned.address,real.pinned.family);
      },
      headers:{accept:'text/html','accept-encoding':'identity','user-agent':'BookFish-egress-design-spike'},
    },res=>{
      let bytes=0;
      const socket=res.socket as import('node:tls').TLSSocket;
      const actual=socket.remoteAddress?.replace(/^::ffff:/u,'');
      if(actual!==real.pinned.address.replace(/^::ffff:/u,'')) {res.destroy();reject(new Error('Unexpected peer'));return;}
      const result={kind:'real-public-tls',status:res.statusCode,dnsCalls,socketLookupCalls,peerMatchesPinned:true,certificateAuthorized:socket.authorized,servername:socket.servername};
      res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>8192)res.destroy(new Error('Probe body limit'));});
      res.on('error',reject);res.on('end',()=>resolve({...result,bytes}));
    });
    req.on('error',reject);req.end();
  });
  console.log(JSON.stringify(outcome));
} catch(error) {
  console.log(JSON.stringify({kind:'real-public-tls',passed:false,code:(error as {code?:string}).code??'probe_failed',scope:'one public TLS probe; production safety not established'}));
  process.exitCode=1;
}
