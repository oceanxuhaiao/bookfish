import { Library } from '../src/library.ts';
import { writeFileSync } from 'node:fs';
const lib=new Library({dataDir:process.argv[2]});
const snapshots:unknown[]=[];
function snap(label:string,active=lib){(globalThis as any).gc?.();snapshots.push({label,...process.memoryUsage(),cache:active.storageStats()});}
snap('cold');const started=Date.now();lib.open();const openMs=Date.now()-started;snap('opened');
const before=lib.status().current!;const listReads=lib.storageStats().reads;
for(let i=0;i<20;i++)lib.list();if(lib.storageStats().reads!==listReads)throw Error('Listing decoded extra pages');
const original=lib.reread(before.key,0).segment.text;const task=lib.readNext();if(task.complete)throw Error('Unexpected end');lib.finish({...task,understanding:'独立存储验证的合成确认，不代表模型阅读。'});snap('confirmed');
const hit=lib.search({query:original.slice(0,10),kind:'text'});if(!hit.items.length)throw Error('Search failed');snap('searched');
if(lib.storageStats().bytes>lib.storageStats().limit)throw Error('Unbounded cache');
const backup=lib.dir+'/bounded-'+Date.now()+'.bfbak';lib.writeArchive(backup);snap('backup');const confirmed=lib.status().current!.confirmedChars;
lib.close();snap('closed');const restore=new Library({dataDir:process.argv[2]+'/bounded-restore-'+Date.now()});restore.open();const restoreStart=Date.now();restore.restoreArchive(backup);const restoreMs=Date.now()-restoreStart;if(restore.status().current?.confirmedChars!==confirmed)throw Error('Restore mismatch');snap('restored',restore);restore.close();
const proof={openMs,restoreMs,snapshots,oldSpaceLimitMiB:96,sourceMiB:100,modelUsed:false};
writeFileSync('output/paged-memory-0.13.0.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
