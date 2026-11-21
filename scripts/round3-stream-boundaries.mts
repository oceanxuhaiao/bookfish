/** Bounded-memory size and write-failure checks, outside the normal fast test suite. */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { prepareFileBestEffort } from '../src/stream-import.ts';
const root=resolve('_verify/stream-boundaries');fs.mkdirSync(root,{recursive:true});
const file=join(root,'exact100.txt'),size=100*1024*1024,buffer=Buffer.alloc(64*1024,0x61);const fd=fs.openSync(file,'w');
try{for(let at=0;at<size;at+=buffer.length)fs.writeSync(fd,buffer);}finally{fs.closeSync(fd);}
const accepted=prepareFileBestEffort(file);assert.equal(accepted.bytes,size);assert.equal(accepted.metrics!.totalChars,size);fs.unlinkSync(accepted.canonicalFile!);
fs.appendFileSync(file,'a');assert.throws(()=>prepareFileBestEffort(file),/exceeds 100 MiB/);fs.truncateSync(file,64*1024);
const original=fs.readFileSync(file),write=fs.writeSync;
try{fs.writeSync=(()=>{throw Object.assign(Error('injected full disk'),{code:'ENOSPC'});}) as typeof fs.writeSync;syncBuiltinESMExports();assert.throws(()=>prepareFileBestEffort(file),{code:'ENOSPC'});}
finally{fs.writeSync=write;syncBuiltinESMExports();}
assert.deepEqual(fs.readFileSync(file),original);assert.deepEqual(fs.readdirSync(root),['exact100.txt']);
console.log(JSON.stringify({exact100MiBAccepted:true,over100MiBRejected:true,writeFailurePreservesOriginal:true,preparedOutputRemoved:true,node:process.version}));
