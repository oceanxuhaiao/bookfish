import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { BookTransfers } from '../src/transfers.ts';
let dir:string,lib:Library,transfers:BookTransfers;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'bookfish-large-'));lib=new Library({dataDir:dir});lib.open();transfers=new BookTransfers(lib);});
afterEach(()=>{transfers.close();lib.close();rmSync(dir,{recursive:true,force:true});});
function upload(bytes:Buffer,kind='book',filename='large.txt',target=transfers){const t=target.begin({kind,filename,title:'大书测试',size:bytes.length});for(let offset=0;offset<bytes.length;offset+=t.chunkBytes)target.chunk(t.id,offset,bytes.subarray(offset,offset+t.chunkBytes).toString('base64'));return target.finish(t.id);}
it('imports multi-megabyte UTF-8 across chunk boundaries; confirmations rewrite only metadata',()=>{
 const bytes=Buffer.from('\uFEFF第一章 海边\r\n'+'海风😀。'.repeat(300000));const result=upload(bytes) as any;expect(result.book.totalChars).toBeGreaterThan(1000000);expect(lib.list()[0].confirmedChars).toBe(0);
 const blob=join(lib.dir,'books',readdirSync(join(lib.dir,'books'))[0]),mtime=statSync(blob).mtimeMs;lib.select(result.book.key);const task=lib.readNext();lib.finish({...task,understanding:'合成测试正文。'});expect(statSync(lib.file).size).toBeLessThan(32768);expect(statSync(blob).mtimeMs).toBe(mtime);
 lib.close();lib.open();expect(lib.status().current!.confirmedSegments).toBe(1);expect(lib.reread(result.book.key,0).segment.text).toContain('😀');
});
it('rejects gaps, conflicting retries and incomplete uploads; allows identical last-chunk retry',()=>{
 const t=transfers.begin({filename:'a.txt',title:'a',size:6});expect(()=>transfers.chunk(t.id,1,'YWJj')).toThrow(/offset/);transfers.chunk(t.id,0,'YWJj');expect(transfers.chunk(t.id,0,'YWJj')).toEqual({offset:3});expect(()=>transfers.chunk(t.id,0,'eHl6')).toThrow(/offset/);expect(()=>transfers.finish(t.id)).toThrow(/incomplete/);transfers.cancel(t.id);expect(lib.list()).toHaveLength(0);expect(readdirSync(join(lib.dir,'transfers'))).toHaveLength(0);
});
it('round-trips a split archive, progress and text into an empty library',()=>{
 const result=upload(Buffer.from('海风😀。'.repeat(300000))) as any;lib.select(result.book.key);const task=lib.readNext();lib.finish({...task,understanding:'合成协议验证'});
 const download=transfers.download(),parts:Buffer[]=[];let offset=0;while(offset<download.size){const c=transfers.read(download.id,offset);parts.push(Buffer.from(c.base64,'base64'));offset=c.nextOffset;}transfers.cancel(download.id);
 const restore=new Library({dataDir:join(dir,'restore')});restore.open();const tx=new BookTransfers(restore);try{upload(Buffer.concat(parts),'backup','sample.bfbak',tx);expect(restore.status().current!.confirmedChars).toBe(lib.status().current!.confirmedChars);expect(restore.reread(result.book.key,0)).toEqual(lib.reread(result.book.key,0));}finally{tx.close();restore.close();}
});
it('migrates an inline book without losing its key and fails closed on a corrupted blob',()=>{
 const result=lib.importBytes({filename:'a.txt',title:'a'},Buffer.from('海风。'.repeat(20000)));const backup=JSON.parse(lib.export());lib.close();writeFileSync(lib.file,backup.payload);lib.open();expect(lib.list()[0].key).toBe(result.book.key);const snapshot=readFileSync(lib.file);lib.close();const blob=join(lib.dir,'books',readdirSync(join(lib.dir,'books'))[0]);writeFileSync(blob,'broken');expect(()=>lib.open()).toThrow();expect(readFileSync(lib.file)).toEqual(snapshot);expect(existsSync(blob)).toBe(true);
});
it('cleans deleted books blobs after the metadata commit',()=>{
 const result=upload(Buffer.from('海风。'.repeat(30000))) as any;expect(readdirSync(join(lib.dir,'books'))).toHaveLength(1);lib.remove(result.book.key);expect(readdirSync(join(lib.dir,'books'))).toHaveLength(0);
});
it('refuses an over-limit upload before allocating its file',()=>{
 expect(()=>transfers.begin({filename:'x.txt',title:'x',size:100*1024*1024+1})).toThrow(/100 MiB/);expect(lib.list()).toHaveLength(0);
});

it('rejects invalid UTF-8 without installing a book and cleans its upload',()=>{
 expect(()=>upload(Buffer.from([0xff]))).toThrow(/UTF-8/);expect(lib.list()).toHaveLength(0);expect(readdirSync(join(lib.dir,'transfers'))).toHaveLength(0);
});
it('expires unfinished transfers and refuses a late chunk',()=>{
 let time=1;const tx=new BookTransfers(lib,()=>time);const t=tx.begin({filename:'a.txt',title:'a',size:3});time+=16*60000;expect(()=>tx.chunk(t.id,0,'YWJj')).toThrow(/expired/);expect(readdirSync(join(lib.dir,'transfers'))).toHaveLength(0);tx.close();
});
it('rejects a truncated archive and leaves the empty library usable',()=>{
 const result=upload(Buffer.from('海风。'.repeat(30000))) as any;const file=join(dir,'full.bfbak');lib.writeArchive(file);const broken=readFileSync(file).subarray(0,100);lib.clear();const bad=join(dir,'bad.bfbak');writeFileSync(bad,broken);expect(()=>lib.restoreArchive(bad)).toThrow();expect(lib.list()).toHaveLength(0);expect(()=>upload(Buffer.from('新书正文。'))).not.toThrow();
});

it('detects metadata corruption before restoring any book',()=>{
 upload(Buffer.from('海风。'.repeat(30000)));const file=join(dir,'good.bfbak');lib.writeArchive(file);const bytes=readFileSync(file),headEnd=bytes.indexOf(10,bytes.indexOf(10)+1);const envelope=JSON.parse(bytes.subarray(bytes.indexOf(10)+1,headEnd).toString());envelope.payload=envelope.payload.replace('"paused":false','"paused":true');const bad=join(dir,'bad-meta.bfbak');writeFileSync(bad,Buffer.concat([Buffer.from(bytes.subarray(0,bytes.indexOf(10)+1).toString()+JSON.stringify(envelope)+'\n'),bytes.subarray(headEnd+1)]));lib.clear();expect(()=>lib.restoreArchive(bad)).toThrow(/checksum/);expect(lib.list()).toHaveLength(0);
});
