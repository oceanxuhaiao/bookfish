import {describe,it,expect} from 'vitest';
import {channel} from 'node:diagnostics_channel';
import {fetchPinned} from '../src/txt-acquisition/pinned-http.ts';
describe('production pinned transport pre-socket refusal',()=>{
  it.each([['93.184.216.34','127.0.0.1'],['2606:4700::1111','::1'],['93.184.216.34','::ffff:10.0.0.1']])('checks every supplied A/AAAA answer before a socket exists: %j',async(...answers)=>{
    let requests=0;const watch=()=>{requests++;};const events=channel('http.client.request.start');events.subscribe(watch);
    try{await expect(fetchPinned('https://public.example/book.txt',{allowNetwork:true,signal:AbortSignal.timeout(1000),resolve:async()=>answers})).rejects.toThrow(/non-public/);expect(requests).toBe(0);}finally{events.unsubscribe(watch);}
  });
  it('rechecks revoked permission after asynchronous DNS and before request creation',async()=>{
    let enabled=true,requests=0;const watch=()=>{requests++;};const events=channel('http.client.request.start');events.subscribe(watch);
    try{await expect(fetchPinned('https://public.example/book.txt',{allowNetwork:true,networkAllowed:()=>enabled,signal:AbortSignal.timeout(1000),resolve:async()=>{enabled=false;return['93.184.216.34'];}})).rejects.toThrow(/disabled/);expect(requests).toBe(0);}finally{events.unsubscribe(watch);}
  });
});
