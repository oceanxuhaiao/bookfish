import {beforeEach,afterEach,it,expect} from 'vitest';
import {mkdtempSync,rmSync,readdirSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Library} from '../src/library.ts';import {BookTransfers} from '../src/transfers.ts';import {buildBook} from '../src/books.ts';
let dir:string,lib:Library,tx:BookTransfers;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'bookfish-worker-'));lib=new Library({dataDir:dir});lib.open();tx=new BookTransfers(lib);});
afterEach(async()=>{await tx.shutdown();lib.close();rmSync(dir,{recursive:true,force:true});});
function upload(bytes:Buffer,title='线程样本'){const t=tx.begin({filename:'sample.txt',title,size:bytes.length});for(let n=0;n<bytes.length;n+=t.chunkBytes)tx.chunk(t.id,n,bytes.subarray(n,n+t.chunkBytes).toString('base64'));return t;}
async function wait(id:string){for(let n=0;n<500;n++){const s=tx.status(id)!;if(!['processing','committing'].includes(s.state))return s;await new Promise(r=>setTimeout(r,10));}throw Error('Worker timeout');}
it('keeps the event loop responsive and commits the exact legacy book after background validation',async()=>{
 const text='第一章 海边\r\n'+'海风😀。'.repeat(200000),bytes=Buffer.from(text);const t=upload(bytes);expect(tx.start(t.id)?.state).toBe('processing');let ticks=0;const timer=setInterval(()=>{ticks++;lib.status();},5);let result;try{result=await wait(t.id);}finally{clearInterval(timer);}expect(result!.state).toBe('done');expect(ticks).toBeGreaterThan(4);expect(lib.list()[0].key).toBe(buildBook('sample.txt','线程样本','',text).key);expect(lib.list()[0].confirmedChars).toBe(0);expect(readdirSync(join(lib.dir,'transfers'))).toEqual([]);lib.close();lib.open();expect(lib.list()).toHaveLength(1);
});
it('cancels a running parser before commit and permits another upload after cleanup',async()=>{
 const old=lib.importBytes({filename:'old.txt',title:'旧书'},Buffer.from('原有正文。'));lib.select(old.book.key);const t=upload(Buffer.from('取消样本。'.repeat(500000)));tx.start(t.id);expect(()=>tx.begin({filename:'x.txt',title:'x',size:1})).toThrow(/already running/);await tx.cancel(t.id);expect(tx.status(t.id)!.state).toBe('cancelled');expect(lib.list()).toHaveLength(1);expect(lib.status().current?.key).toBe(old.book.key);expect(readdirSync(join(lib.dir,'transfers'))).toEqual([]);const next=upload(Buffer.from('后续正文。'));tx.start(next.id);expect((await wait(next.id)).state).toBe('done');
});
it('fails closed on late invalid UTF-8 and keeps the original shelf',async()=>{
 lib.importBytes({filename:'old.txt',title:'旧书'},Buffer.from('旧书。'));const t=upload(Buffer.concat([Buffer.from('有效。'.repeat(20000)),Buffer.from([0xe4,0xb8])]));tx.start(t.id);const s=await wait(t.id);expect(s.state).toBe('failed');expect(s.error).toMatch(/UTF-8/);expect(lib.list()).toHaveLength(1);expect(readdirSync(join(lib.dir,'transfers'))).toEqual([]);
});
it('uses current library state at commit and preserves duplicate progress',async()=>{
 const bytes=Buffer.from('风。'.repeat(10000));const old=lib.importBytes({filename:'sample.txt',title:'线程样本'},bytes);lib.select(old.book.key);const read=lib.readNext();lib.finish({...read,understanding:'风起。'});const t=upload(bytes);tx.start(t.id);lib.setPaused(true);const s=await wait(t.id);expect(s.state).toBe('done');expect((s.result as any).duplicate).toBe(true);expect(lib.status().paused).toBe(true);expect(lib.list()).toHaveLength(1);expect(lib.list()[0].confirmedSegments).toBe(1);
});
it('stops the worker before library shutdown and never commits a late result',async()=>{
 const t=upload(Buffer.from('关闭样本。'.repeat(500000)));tx.start(t.id);await tx.shutdown();lib.close();lib.open();expect(lib.list()).toEqual([]);expect(tx.status(t.id)!.state).toBe('cancelled');expect(readdirSync(join(lib.dir,'transfers'))).toEqual([]);
});
it('recovers only owned flat staging files and leaves unrelated files untouched',()=>{
 const root=join(lib.dir,'transfers');mkdirSync(root,{recursive:true});const id='12345678-1234-1234-1234-123456789abc';const work=join(root,id+'.import');mkdirSync(work);writeFileSync(join(work,id+'.canonical.tmp'),'partial');writeFileSync(join(work,'a'.repeat(64)+'.json.gz'),'partial');writeFileSync(join(root,id+'.part'),'partial');writeFileSync(join(root,'keep.txt'),'user');tx.recover();expect(existsSync(work)).toBe(false);expect(readFile('keep.txt')).toBe(true);function readFile(n:string){return existsSync(join(root,n));}
});
it('refuses unexpected staging contents instead of recursively deleting them',()=>{
 const root=join(lib.dir,'transfers'),work=join(root,'12345678-1234-1234-1234-123456789abc.import');mkdirSync(work,{recursive:true});writeFileSync(join(work,'personal.txt'),'keep');expect(()=>tx.recover()).toThrow(/Unexpected/);expect(existsSync(join(work,'personal.txt'))).toBe(true);
});
it('does not install an imported blob when the metadata commit fails',async()=>{
 await tx.shutdown();lib.close();let fail=false;lib=new Library({dataDir:dir,beforeMetadataCommit:()=>{if(fail)throw Error('simulated disk failure');}});lib.open();tx=new BookTransfers(lib);const t=upload(Buffer.from('写入失败。'));fail=true;tx.start(t.id);const s=await wait(t.id);expect(s.state).toBe('failed');expect(lib.list()).toEqual([]);expect(readdirSync(join(lib.dir,'transfers'))).toEqual([]);fail=false;lib.close();lib.open();expect(lib.list()).toEqual([]);
});

it('recovers abandoned metadata and book temporaries only after validating the committed snapshot',()=>{
 const id='12345678-1234-1234-1234-123456789abc';lib.close();const meta=join(lib.dir,'library.json.'+id+'.tmp'),books=join(lib.dir,'books');mkdirSync(books,{recursive:true});writeFileSync(meta,'partial');const canonical=join(books,id+'.canonical.tmp');writeFileSync(canonical,'partial');const unrelated=join(books,'keep.txt');writeFileSync(unrelated,'keep');lib.open();expect(existsSync(meta)).toBe(false);expect(existsSync(canonical)).toBe(false);expect(existsSync(unrelated)).toBe(true);
});
