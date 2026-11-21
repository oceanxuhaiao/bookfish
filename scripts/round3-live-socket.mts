/** Public HTTPS only; observes the actual production request socket, without replacing transport. */
import { channel } from 'node:diagnostics_channel';
import { lookup } from 'node:dns/promises';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fetchPinned } from '../src/txt-acquisition/pinned-http.ts';
const records:any[]=[];let answers:string[]=[];let resolutions=0;
const observer=({request}:any)=>{const row:any={host:request.getHeader('host'),agentReuse:request.reusedSocket??false};records.push(row);const watch=(socket:any)=>{const capture=()=>Object.assign(row,{remoteAddress:socket.remoteAddress,remotePort:socket.remotePort,servername:socket.servername,authorized:socket.authorized});if(socket.remoteAddress&&socket.authorized)capture();else socket.once('secureConnect',capture);};if(request.socket)watch(request.socket);else request.once('socket',watch);};
const events=channel('http.client.request.start');events.subscribe(observer);
try{const response=await fetchPinned('https://example.com/',{allowNetwork:true,signal:AbortSignal.timeout(25000),resolve:async host=>{resolutions++;answers=(await lookup(host,{all:true,verbatim:true})).map(a=>a.address);return answers;}});const body=await response.arrayBuffer();assert.ok(response.ok);assert.equal(resolutions,1);assert.equal(records.length,1);assert.ok(answers.includes(records[0].remoteAddress));assert.equal(records[0].host,'example.com');assert.equal(records[0].servername,'example.com');assert.equal(records[0].authorized,true);const result={passed:true,resolutions,answers,records,status:response.status,bytes:body.byteLength,scope:'one real public HTTPS request through production fetchPinned; not proof of every address family or browser isolation'};writeFileSync('_verify/r3-live-socket.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));}finally{events.unsubscribe(observer);}

