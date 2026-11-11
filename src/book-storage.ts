import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, statSync, openSync, closeSync, readSync, writeSync, fsyncSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { importFileBlob } from './stream-import.ts';
import type { Book } from './books.ts';
import type { LibraryState } from './library.ts';
import { PageCache, fileHash, pagedFile, loadPagedBook, writePagedBook, appendPagedBook } from './paged-book.ts';
import { samePath } from './text-store.ts';
const MAX_JSON = 320 * 1024 * 1024;
const MAX_META = 320 * 1024 * 1024;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const validHash = (v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
/** Immutable book blobs are committed before the small progress snapshot. */
export class BookStorage {
  readonly metaRoot:string;
  private bodyDir:string;
  private readonly legacyDirs=new Set<string>();
  private refs=new WeakMap<Book,string>();
  private rollbackRefs?:Set<string>;
  private rollbackSet(){
    if(this.rollbackRefs)return this.rollbackRefs;const sidecar=join(this.metaRoot,'rollback-book-refs.json');const keep=new Set<string>();
    if(existsSync(sidecar)){const ids=JSON.parse(readFileSync(sidecar,'utf8'));if(!Array.isArray(ids)||ids.some(id=>!validHash(id)))throw Error('Invalid rollback book references');for(const id of ids)keep.add(id);}
    else for(const name of ['library.json.before-paged','library.json.before-history']){const file=join(this.metaRoot,name);if(existsSync(file)){const old=JSON.parse(readFileSync(file,'utf8'));for(const e of old.books??[])if(validHash(e.book?.$bookBlob))keep.add(e.book.$bookBlob);}}
    this.rollbackRefs=keep;return keep;
  }
  protectRollback(raw:{books?:Array<{book?:{$bookBlob?:unknown}}>}){const keep=this.rollbackSet();for(const e of raw.books??[])if(validHash(e.book?.$bookBlob))keep.add(e.book.$bookBlob);const file=join(this.metaRoot,'rollback-book-refs.json'),tmp=file+'.'+randomUUID()+'.tmp';const fd=openSync(tmp,'wx');try{writeFileSync(fd,JSON.stringify([...keep]));fsyncSync(fd);}finally{closeSync(fd);}try{renameSync(tmp,file);}finally{if(existsSync(tmp))unlinkSync(tmp);}}

  constructor(metaRoot:string, bodyDir?:string){this.metaRoot=metaRoot;this.bodyDir=bodyDir?resolve(bodyDir):join(metaRoot,'books');}
  get dir(){return this.bodyDir;}
  get textStoreDir(){return this.bodyDir;}
  private pathIn(dir:string,id:string){if(!validHash(id))throw Error('Invalid book blob id');return join(dir,id+'.json.gz');}
  private path(id:string){return this.pathIn(this.bodyDir,id);}
  private source(id:string):string{
    const primary=this.path(id);if(existsSync(primary))return primary;
    for(const dir of this.legacyDirs){const file=this.pathIn(dir,id);if(existsSync(file))return file;}
    throw Error('Book text not found at the configured storage folder; restore the file or reset the full-text storage setting');
  }
  /** Copy immutable blobs from the previous folder into the configured one; originals are kept as rollback. */
  prepareTextStore(configured:string, defaultDir:string){
    const target=configured.trim()?resolve(configured):resolve(defaultDir);
    const sidecar=join(this.metaRoot,'text-store.json');let previous:string|null=null;
    try{const raw=JSON.parse(readFileSync(sidecar,'utf8'));if(typeof raw.dir==='string'&&raw.dir.trim())previous=resolve(raw.dir);}catch{}
    this.bodyDir=target;mkdirSync(target,{recursive:true});
    const sources=new Set<string>([resolve(defaultDir),...(previous?[previous]:[])]);
    let moved=0;
    for(const source of sources){if(samePath(source,target))continue;this.legacyDirs.add(source);moved+=this.migrateFrom(source);}
    this.legacyDirs.add(previous??resolve(defaultDir));
    const tmp=join(this.metaRoot,`text-store.json.${randomUUID()}.tmp`);
    writeFileSync(tmp,JSON.stringify({dir:target,updatedAt:new Date().toISOString()}));
    renameSync(tmp,sidecar);
    return {dir:target,previous,moved};
  }
  fallbackToDefault(defaultDir:string){this.legacyDirs.add(this.bodyDir);this.bodyDir=resolve(defaultDir);mkdirSync(this.bodyDir,{recursive:true});}
  private migrateFrom(source:string){
    if(!existsSync(source)||!statSync(source).isDirectory())return 0;
    let moved=0;
    for(const name of readdirSync(source)){
      if(!/^[a-f0-9]{64}\.json\.gz$/.test(name))continue;
      const from=join(source,name),to=join(this.bodyDir,name);
      if(existsSync(to)&&statSync(to).size===statSync(from).size)continue;
      const tmp=to+'.'+randomUUID()+'.tmp';
      copyFileSync(from,tmp);renameSync(tmp,to);moved++;
    }
    return moved;
  }
  readonly cache=new PageCache();
  private readonly serialBlobs=new Map<string,{id:string;segments:number;chapters:number}>();
  private ensure(book:Book,force=false):string|undefined{
    const saved=this.refs.get(book);if(saved)return saved;
    const serial=book.remote?.serial;
    if(serial){
      const known=this.serialBlobs.get(serial.serialId);
      if(known){
        if(book.segments.length<known.segments||book.remote!.cache.length<known.chapters)throw Error('Serial book shrank below its committed blob');
        const newSegments=[];for(let i=known.segments;i<book.segments.length;i++)newSegments.push(book.segments[i]);
        const newChapters=[];for(let i=known.chapters;i<book.remote!.cache.length;i++)newChapters.push(book.remote!.cache[i]);
        if(!newSegments.length&&!newChapters.length)return known.id;
        mkdirSync(this.dir,{recursive:true});const {id}=appendPagedBook(this.dir,this.path(known.id),book,newSegments,newChapters);
        this.serialBlobs.set(serial.serialId,{id,segments:book.segments.length,chapters:book.remote!.cache.length});
        this.refs.set(book,id);this.lazy.add(book);return id;
      }
    }
    if(!force&&book.totalChars<8192)return undefined;
    mkdirSync(this.dir,{recursive:true});const id=writePagedBook(this.dir,book);this.refs.set(book,id);
    if(serial){this.serialBlobs.set(serial.serialId,{id,segments:book.segments.length,chapters:book.remote!.cache.length});this.lazy.add(book);}
    return id;
  }
  importFile(file:string,metadata:{filename:unknown;title:unknown;author?:unknown}){
    mkdirSync(this.dir,{recursive:true});const id=importFileBlob(this.dir,file,metadata),book=loadPagedBook(this.path(id),id,this.cache);this.refs.set(book,id);this.lazy.add(book);return book;
  }
  adoptValidatedImport(file:string,id:string,receipt:{size:number;mtimeMs:number}){
    if(!validHash(id))throw Error('Invalid imported blob');
    // Rebind a manifest verified in our own worker, then move on the same filesystem.
    const candidate=loadPagedBook(file,id,new PageCache(),receipt);if(candidate.remote)throw Error('Import must be local');
    mkdirSync(this.dir,{recursive:true});const target=this.path(id);renameSync(file,target);
    const book=loadPagedBook(target,id,this.cache,{size:statSync(target).size,mtimeMs:statSync(target).mtimeMs});this.refs.set(book,id);this.lazy.add(book);return book;
  }
  prepare(state:LibraryState,force=false):unknown{
    const books=state.books.map(e=>{const id=this.ensure(e.book,force);if(id&&!this.lazy.has(e.book)){const book=loadPagedBook(this.source(id),id,this.cache);this.refs.set(book,id);this.lazy.add(book);e.book=book;}return {frontier:e.frontier,book:id?{$bookBlob:id}:e.book,...(e.serial?{serial:e.serial}:{})};});return {...state,schema:books.some(e=>'$bookBlob' in e.book)?5:state.schema,books};
  }
  private lazy=new WeakSet<Book>();
  clearCache(){this.cache.clear();}
  hydrate(raw:unknown):unknown{
    if(!raw||typeof raw!=='object'||!Array.isArray((raw as LibraryState).books))return raw;
    const v=raw as LibraryState;if(v.books.length>100)throw Error('Invalid library book count');let decodedChars=0;
    return {...v,schema:[4,5,6,7].includes((raw as {schema?:number}).schema??0)?3:v.schema,books:v.books.map(e=>{
      const ref=e?.book as unknown as {$bookBlob?:unknown};if(!ref||!('$bookBlob' in ref))return e;
      if(!validHash(ref.$bookBlob))throw Error('Invalid book reference');
      const file=this.source(ref.$bookBlob);if(statSync(file).size>MAX_JSON)throw Error('Book blob oversized');
      if(pagedFile(file)){const book=loadPagedBook(file,ref.$bookBlob,this.cache);decodedChars+=book.totalChars;if(decodedChars>128*1024*1024)throw Error('Stored library exceeds decoded size limit');this.refs.set(book,ref.$bookBlob);this.lazy.add(book);if(book.remote?.serial)this.serialBlobs.set(book.remote.serial.serialId,{id:ref.$bookBlob,segments:book.segments.length,chapters:book.remote.cache.length});return {...e,book};}
      const json=gunzipSync(readFileSync(file),{maxOutputLength:MAX_JSON});if(hash(json)!==ref.$bookBlob)throw Error('Book blob checksum mismatch');
      const book=JSON.parse(json.toString('utf8')) as Book&{$segmentsOnly?:boolean};if(!Number.isSafeInteger(book.totalChars)||book.totalChars<1||book.totalChars>100*1024*1024||decodedChars+book.totalChars>128*1024*1024)throw Error('Stored library exceeds decoded size limit');decodedChars+=book.totalChars;if(book.$segmentsOnly){if(!Array.isArray(book.segments)||book.segments.length>200000||book.segments.some(s=>typeof s.text!=='string'||s.text.length>2400))throw Error('Invalid stored segment index');let chars=0,bytes=0;for(const segment of book.segments){chars+=Array.from(segment.text).length;bytes+=Buffer.byteLength(segment.text);}if(chars!==book.totalChars||bytes>100*1024*1024)throw Error('Stored book size mismatch');book.text=book.segments.map(s=>s.text).join('');delete book.$segmentsOnly;}return {...e,book};
    })};
  }
  collect(state:LibraryState){
    if(!existsSync(this.dir))return;const keep=new Set(state.books.map(e=>this.refs.get(e.book)).filter(Boolean));
    for(const id of this.rollbackSet())keep.add(id);
    for(const name of readdirSync(this.dir)){if(/^[a-f0-9]{64}\.json\.gz$/.test(name)&&!keep.has(name.slice(0,64)))unlinkSync(join(this.dir,name));}
  }
  writeArchive(file:string,state:LibraryState,history?:{file:string;ref:unknown}){
    const prepared=this.prepare(state,true) as {books:Array<{book:{$bookBlob:string}}>};const serial=state.books.some(e=>e.book.remote?.serial);const manifest=history?{...prepared,schema:serial?7:6,tasks:[],episodes:[],$history:history.ref}:prepared;
    const ids=[...new Set(manifest.books.map(e=>e.book.$bookBlob))];
    const fd=openSync(file,'wx');let size=0;
    const write=(v:Uint8Array|string)=>{const b=typeof v==='string'?Buffer.from(v):v;let at=0;while(at<b.length)at+=writeSync(fd,b,at,b.length-at);size+=b.length;};
    try{write(history?(serial?'BOOKFISH4\n':'BOOKFISH3\n'):'BOOKFISH2\n');const payload=JSON.stringify(manifest);write(JSON.stringify({checksum:hash(payload),payload})+'\n');for(const id of ids){const source=openSync(this.source(id),'r');try{write(JSON.stringify({id,size:statSync(this.source(id)).size})+'\n');const chunk=Buffer.alloc(256*1024);let n;while((n=readSync(source,chunk,0,chunk.length,null)))write(chunk.subarray(0,n));}finally{closeSync(source);}}if(history){write(JSON.stringify({id:'history',size:statSync(history.file).size,checksum:fileHash(history.file)})+'\n');const source=openSync(history.file,'r');try{const chunk=Buffer.alloc(256*1024);let n;while((n=readSync(source,chunk,0,chunk.length,null)))write(chunk.subarray(0,n));}finally{closeSync(source);}}fsyncSync(fd);}finally{closeSync(fd);}return {size};
  }
  readArchive(file:string,historySink?:(file:string,ref:unknown,state:LibraryState)=>LibraryState):unknown{
    const fd=openSync(file,'r');let offset=0;const total=statSync(file).size;
    const line=()=>{const parts:Buffer[]=[];let count=0;while(offset<total){const b=Buffer.alloc(Math.min(65536,total-offset));const n=readSync(fd,b,0,b.length,offset);if(!n)break;const end=b.subarray(0,n).indexOf(10);const length=end<0?n:end;parts.push(b.subarray(0,length));offset+=length+(end<0?0:1);count+=length;if(count>MAX_META)throw Error('Backup manifest oversized');if(end>=0)return Buffer.concat(parts).toString('utf8');}throw Error('Truncated backup header');};
    try{
      const magic=line();if(!['BOOKFISH2','BOOKFISH3','BOOKFISH4'].includes(magic))throw Error('Unsupported backup archive');
      const header=JSON.parse(line());let manifest;if(typeof header.payload==='string'){if(hash(header.payload)!==header.checksum)throw Error('Backup metadata checksum mismatch');manifest=JSON.parse(header.payload);}else manifest=header;if(!Array.isArray(manifest.books)||manifest.books.length>100)throw Error('Invalid archive books');
      const ids=[...new Set<string>(manifest.books.map((e:{book:{$bookBlob:string}})=>e.book?.$bookBlob))];mkdirSync(this.dir,{recursive:true});
      for(const id of ids){if(!validHash(id))throw Error('Invalid archive book reference');const header=JSON.parse(line());if(header.id!==id||!Number.isSafeInteger(header.size)||header.size<1||header.size>MAX_JSON||offset+header.size>total)throw Error('Invalid archive blob');
        const tmp=this.path(id)+'.'+randomUUID()+'.tmp',out=openSync(tmp,'wx');try{let remaining=header.size;const chunk=Buffer.alloc(256*1024);while(remaining){const n=readSync(fd,chunk,0,Math.min(chunk.length,remaining),offset);if(!n)throw Error('Truncated archive');let at=0;while(at<n)at+=writeSync(out,chunk,at,n-at);offset+=n;remaining-=n;}fsyncSync(out);}catch(error){closeSync(out);if(existsSync(tmp))unlinkSync(tmp);throw error;}finally{try{closeSync(out);}catch{}}
        try{renameSync(tmp,this.path(id));}finally{if(existsSync(tmp))unlinkSync(tmp);}
      }
      if(magic==='BOOKFISH3'||magic==='BOOKFISH4'){
        const header=JSON.parse(line());if(header.id!=='history'||!validHash(header.checksum)||!Number.isSafeInteger(header.size)||header.size<1||header.size>512*1024*1024||offset+header.size!==total||!historySink)throw Error('Invalid history archive');
        const tmp=join(this.metaRoot,randomUUID()+'.history-restore.sqlite'),out=openSync(tmp,'wx');try{const chunk=Buffer.alloc(256*1024);let remaining=header.size;while(remaining){const n=readSync(fd,chunk,0,Math.min(chunk.length,remaining),offset);if(!n)throw Error('Truncated history archive');let at=0;while(at<n)at+=writeSync(out,chunk,at,n-at);offset+=n;remaining-=n;}fsyncSync(out);}finally{closeSync(out);}
        try{if(fileHash(tmp)!==header.checksum)throw Error('History archive checksum mismatch');return historySink(tmp,manifest.$history,this.hydrate(manifest) as LibraryState);}finally{if(existsSync(tmp))unlinkSync(tmp);}
      }
      if(offset!==total)throw Error('Unexpected backup tail');return this.hydrate(manifest);
    }finally{closeSync(fd);}
  }
}
