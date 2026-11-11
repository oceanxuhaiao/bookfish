// Restore only into a fresh isolated Library, never clear the real user library.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Library } from '../src/library.ts';
const base='http://127.0.0.1:17788';
async function call(method,args=[]) { const r=await fetch(`${base}/api/webui/providers/world%3Abookfish/panels/status/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({args})});if(!r.ok)throw new Error(await r.text());return r.json(); }
const current=await call('get'), backup=await call('export'), shares=await call('export_shares');
const key=current.books.find(b=>b.title==='多出来的一枚硬币（阶段8验收）').key;
const source=JSON.parse(JSON.parse(backup).payload);const versions=source.reviews.filter(r=>r.bookKey===key);
if(!versions.length)throw new Error('No real model article to restore');
mkdirSync('output/host-fixture',{recursive:true});const lib=new Library({dataDir:mkdtempSync(join(process.cwd(),'output/host-fixture/stage8-restore-'))});
try {lib.open();lib.restore(backup);const restored=JSON.parse(JSON.parse(lib.export()).payload);
const checks={schema3:restored.schema===3,allBooks:restored.books.length===source.books.length,allArticles:isDeepStrictEqual(restored.reviews,source.reviews),allEpisodes:isDeepStrictEqual(restored.episodes,source.episodes),
  exactCitations:versions.every(v=>lib.review(v.id).evidence.every(e=>e.exactTextMatched)),reviewChain:lib.reviews(key).versions.length===versions.length,shareArchiveExplicit:JSON.parse(shares).format==='bookfish-share-archive-v1',
  xiyouPreserved:lib.list().find(b=>b.title==='西游记').confirmedChars===3600};
lib.remove(key);const deleted=JSON.parse(JSON.parse(lib.export()).payload);checks.deleteRemovesReviews=deleted.reviews.every(r=>r.bookKey!==key)&&deleted.reviewJobs.every(j=>j.bookKey!==key)&&deleted.episodes.every(e=>e.bookKey!==key);
checks.otherBookPreserved=lib.list().some(b=>b.title==='西游记'&&b.confirmedChars===3600);
writeFileSync('output/live-stage8-backup-check.json',JSON.stringify({at:new Date().toISOString(),checks,scope:'Actual model-authored backup restored and deletion checked in an isolated Library only'},null,2));
writeFileSync('output/live-backups/stage8-final-library.json',backup);writeFileSync('output/live-backups/stage8-share-archive.json',shares);
console.log(JSON.stringify(checks));if(Object.values(checks).some(v=>!v))process.exitCode=1;
}finally{lib.close();}
