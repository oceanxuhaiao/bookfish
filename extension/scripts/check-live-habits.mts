import {readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {isDeepStrictEqual as eq} from 'node:util';
import {Library} from '../src/library.ts';
const base='http://127.0.0.1:17788/api/webui/providers/world%3Abookfish/panels/';
async function call(p:string,m:string,args:unknown[]=[]):Promise<any>{const r=await fetch(base+p+'/'+m,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({args})});if(!r.ok)throw Error(await r.text());return r.json();}
const before=JSON.parse(readFileSync('output/live-backups/habits-before-0.19.0.json','utf8'));
const fixture=JSON.parse(readFileSync('output/live-backups/habits-fixture-0.19.0.json','utf8'));
const timeline=await call('status','timeline',[{bookKey:fixture.key}]);
if(!timeline.rests?.length)throw Error('Actual rest missing');
const transfer=await call('status','backup_begin');const parts:Buffer[]=[];
try{let offset=0;while(offset<transfer.size){const part=await call('status','backup_read',[transfer.id,offset]);if(part.nextOffset<=offset)throw Error('Stalled');parts.push(Buffer.from(part.base64,'base64'));offset=part.nextOffset;}}finally{await call('status','transfer_cancel',[transfer.id]);}
const archive=resolve('output/live-backups/habits-0.19.1.bfbak');writeFileSync(archive,Buffer.concat(parts));
const restored=new Library({dataDir:resolve('output/large-file-check/habits-restore-'+Date.now())});restored.open();
try{restored.restoreArchive(archive);if(!eq(restored.timeline(fixture.key).rests,timeline.rests))throw Error('Rest archive mismatch');}finally{restored.close();}
await call('settings','save',[{automaticReading:false}]);
const current=await call('status','get');const owned=current.books.find((b:any)=>b.key===fixture.key);
if(!owned||!owned.title.startsWith('节奏与章节目标验收（合成）'))throw Error('Owned fixture mismatch');
await call('status','remove',[fixture.key]);
await call('status','select',[before.status.library.current.key]);
await call('settings','save',[{automaticReading:before.config.automaticReading,readingCharsPerMinute:before.config.readingCharsPerMinute??0,readingSessionMinutes:before.config.readingSessionMinutes??10,dailyChapterGoal:before.config.dailyChapterGoal??0}]);
const after=await call('status','get');
const oldConfigPreserved=Object.entries(before.config).every(([k,v])=>eq(after.config[k],v));
const progressPreserved=before.books.length===after.books.length&&before.books.every((b:any)=>after.books.some((a:any)=>a.key===b.key&&a.confirmedChars>=b.confirmedChars));
if(!oldConfigPreserved||!progressPreserved||after.status.library.current.key!==before.status.library.current.key||after.config.dailyChapterGoal!==0)throw Error('Restoration mismatch');
const files:string[]=[];function walk(p:string){for(const n of readdirSync(p)){const f=join(p,n);statSync(f).isDirectory()?walk(f):files.push(f);}}walk('src');walk('lib');let mismatches=0,credentialShapes=0;
for(const f of files){const bytes=readFileSync(f);if(!bytes.equals(readFileSync('E:/zcdfy/Coopanion/data/local-extensions/bookfish-0.19.1/'+f)))mismatches++;if(/sk-[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(bytes.toString()))credentialShapes++;}
const proof={version:'0.19.1',realBackupBytes:transfer.size,realRestArchiveRestoredInIsolation:true,fixtureRemoved:true,oldConfigPreserved,progressPreserved,originalBookSelected:true,bookCount:after.books.length,dailyChapterGoal:after.config.dailyChapterGoal,readingSessionMinutes:after.config.readingSessionMinutes,installFiles:files.length,installMismatches:mismatches,credentialShapeMatches:credentialShapes};writeFileSync('output/live-habits-final-0.19.1.json',JSON.stringify(proof,null,2));console.log(proof);if(mismatches||credentialShapes)throw Error('Install integrity failed');
