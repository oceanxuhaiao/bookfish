import { beforeEach,afterEach,it,expect } from 'vitest';
import { mkdtempSync,rmSync,readFileSync,writeFileSync,statSync } from 'node:fs';
import { join } from 'node:path';import { tmpdir } from 'node:os';import { createRequire } from 'node:module';
import { Library } from '../src/library.ts';
let dir:string,lib:Library,fail=false;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'bookfish-history-'));fail=false;lib=new Library({dataDir:dir,beforeMetadataCommit:()=>{if(fail)throw Error('metadata commit failed');}});lib.open();});
afterEach(()=>{lib.close();rmSync(dir,{recursive:true,force:true});});
function prepare(){const b=lib.import({filename:'a.txt',title:'索引测试',base64:Buffer.from('海风。').toString('base64')}).book;lib.select(b.key);const t=lib.readNext();if(t.complete)throw Error('No task');return {b,t};}
function episode(){return {trigger:'风起了',interpretation:'我想在这里待一会儿。',mood:{label:'平静'},evidence:[{segmentId:0,quote:'海风。'}]};}
it('keeps tasks and journal outside metadata and indexes exact record relationships after restart',()=>{
 const {t}=prepare();const result=lib.finish({...t,understanding:'海边起风。',episode:episode()});const id=result.receipt.episodeId!;lib.reflect({bookKey:t.bookKey,requestId:'later',revises:id,episode:episode()});
 const raw=JSON.parse(readFileSync(lib.file,'utf8'));expect(raw.schema).toBe(6);expect(raw.tasks).toEqual([]);expect(raw.episodes).toEqual([]);expect(statSync(join(lib.dir,'history.sqlite')).size).toBeGreaterThan(0);
 const before=lib.journal();lib.close();lib.open();expect(lib.journal()).toEqual(before);expect(lib.episode(id).revisions).toHaveLength(1);expect(lib.timeline().items[0].mood?.label).toBe('平静');expect(lib.finish({...t,understanding:'海边起风。',episode:episode()}).duplicate).toBe(true);
});
it('keeps both progress and journal at the old snapshot if metadata commit fails after SQL commit, including remount recovery',()=>{
 const {t}=prepare(),old=readFileSync(lib.file);fail=true;expect(()=>lib.finish({...t,understanding:'风起。',episode:episode()})).toThrow(/metadata commit/);expect(readFileSync(lib.file)).toEqual(old);expect(lib.status().current?.confirmedSegments).toBe(0);expect(lib.journal().total).toBe(0);
 lib.close();fail=false;lib.open();expect(lib.status().current?.confirmedSegments).toBe(0);expect(lib.journal().total).toBe(0);const fresh=lib.readNext();expect(lib.finish({...fresh,understanding:'重新确认。',episode:episode()}).duplicate).toBe(false);expect(lib.journal().total).toBe(1);
});
it('recovers a failed SQL-ahead snapshot on the next successful transaction without reopening',()=>{
 const {t}=prepare();fail=true;expect(()=>lib.finish({...t,understanding:'风起。',episode:episode()})).toThrow();fail=false;lib.finish({...t,understanding:'风起。',episode:episode()});expect(lib.journal().total).toBe(1);lib.close();lib.open();expect(lib.status().current?.confirmedSegments).toBe(1);
});
it('rejects body tampering, stale indexes and missing rows instead of silently rebuilding an empty history',()=>{
 const {t}=prepare();lib.finish({...t,understanding:'风起。',episode:episode()});lib.close();const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');const db=new DatabaseSync(join(lib.dir,'history.sqlite'));db.exec("UPDATE history SET json=replace(json,'我想','伪造') WHERE kind='episodes'");db.close();const saved=readFileSync(lib.file);expect(()=>lib.open()).toThrow(/checksum/);expect(readFileSync(lib.file)).toEqual(saved);
});
it('restores a SQLite history archive into an empty library and preserves revisions, then deletes only the chosen book history',()=>{
 const {t}=prepare();const id=lib.finish({...t,understanding:'风起。',episode:episode()}).receipt.episodeId!;lib.reflect({bookKey:t.bookKey,requestId:'revision',revises:id,episode:episode()});const file=join(dir,'backup.bfbak');lib.writeArchive(file);expect(readFileSync(file).subarray(0,10).toString()).toBe('BOOKFISH3\n');
 const restored=new Library({dataDir:join(dir,'restored')});try{restored.open();restored.restoreArchive(file);expect(restored.journal()).toEqual(lib.journal());restored.remove(t.bookKey);restored.close();restored.open();expect(restored.list()).toEqual([]);expect(()=>restored.episode(id)).toThrow();}finally{restored.close();}
});

it('invalidates a backed-up pending task durably when restoring a read-only SQLite snapshot',()=>{
 const {t}=prepare();const file=join(dir,'pending.bfbak');lib.writeArchive(file);const restored=new Library({dataDir:join(dir,'pending')});try{restored.open();restored.restoreArchive(file);restored.close();restored.open();expect(restored.status().current?.confirmedSegments).toBe(0);expect(restored.readNext().taskId).not.toBe(t.taskId);}finally{restored.close();}
});
it('keeps an empty restore target usable after metadata commit failure and reclaims the failed future version',()=>{
 const {t}=prepare();lib.finish({...t,understanding:'风起。',episode:episode()});const file=join(dir,'failure.bfbak');lib.writeArchive(file);let reject=false;const restored=new Library({dataDir:join(dir,'failure'),beforeMetadataCommit:()=>{if(reject)throw Error('disk failure');}});try{restored.open();const before=readFileSync(restored.file);reject=true;expect(()=>restored.restoreArchive(file)).toThrow(/disk failure/);expect(restored.list()).toEqual([]);expect(readFileSync(restored.file)).toEqual(before);restored.close();reject=false;restored.open();restored.restoreArchive(file);expect(restored.journal().total).toBe(1);}finally{restored.close();}
});
