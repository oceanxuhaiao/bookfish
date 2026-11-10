import {readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual as eq} from 'node:util';
const base='http://127.0.0.1:17788/api/webui/providers/world%3Abookfish/panels/status/';
async function call(method,args=[]){const r=await fetch(base+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({args})});if(!r.ok)throw Error(await r.text());return r.json();}
const original=JSON.parse(readFileSync('output/live-backups/reader-before-0.20.0.json','utf8'));
const before=await call('get');const book=before.books.find(b=>b.key===before.status.library.current.key);
const first=await call('reader',[{bookKey:book.key}]);const second=await call('reader',[{bookKey:book.key,segment:first.next??0}]);const after=await call('get');
if(!eq(before.books,after.books)||!eq(before.status.library,after.status.library))throw Error('Human reader mutated library');
if(!eq(original.config,after.config)||original.books.length!==after.books.length||!original.books.every(b=>after.books.some(a=>a.key===b.key&&a.confirmedChars>=b.confirmedChars))||original.status.library.current.key!==after.status.library.current.key)throw Error('Upgrade preservation failed');
const files=[];function walk(p){for(const n of readdirSync(p)){const f=join(p,n);statSync(f).isDirectory()?walk(f):files.push(f);}}walk('src');walk('lib');let mismatch=0,credentials=0;
for(const f of files){const b=readFileSync(f);if(!b.equals(readFileSync('E:/zcdfy/Coopanion/data/local-extensions/bookfish-0.20.0/'+f)))mismatch++;if(/sk-[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(b.toString()))credentials++;}
const extensions=await fetch('http://127.0.0.1:17788/api/extensions').then(r=>r.json());const loaded=extensions.extensions.find(e=>e.name==='cortico-world-bookfish');
const proof={version:loaded.version,loaded:loaded.loaded,bookCount:after.books.length,originalConfigAndBooksPreserved:true,originalSelectionPreserved:true,humanReadingDidNotChangePetProgress:true,firstBatchSegments:first.segments.length,secondBatchSegments:second.segments.length,firstBatchCodepoints:Array.from(first.segments.map(s=>s.text).join('')).length,directoryBatch:first.chapters.length,novelTextExcludedFromProof:true,browserObserved:['affected journal row now shows 😔, no fixed thought bubble','local novel read and next section','example filled; indeterminate checking state; successful preview; not accepted into shelf'],installFiles:files.length,installMismatches:mismatch,credentialShapeMatches:credentials};
writeFileSync('output/live-reader-0.20.0.json',JSON.stringify(proof,null,2));console.log(proof);if(mismatch||credentials)throw Error('Integrity mismatch');
