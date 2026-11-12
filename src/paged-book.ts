import { createHash, randomUUID } from 'node:crypto';
import { openSync, closeSync, readSync, writeSync, fsyncSync, renameSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Book, Segment } from './books.ts';
import { streamIndex } from './stream-index.ts';
import { buildRemoteBook, serialContentHash } from './remote-books.ts';
import { catalogHash } from './biquge.ts';
import { stableSerialIdentity, validateSerialCatalog, validateSerialRecord, type SerialRecord } from './serial-types.ts';
import type { CachedChapter } from './source-types.ts';
const MAGIC = 'BOOKPAGE1\n';
const PAGE_SIZE = 64;
const MAX_PAGE = 2 * 1024 * 1024;
const MAX_MANIFEST = 8 * 1024 * 1024;
const sha = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
interface Page { offset: number; size: number; hash: string; count: number }
interface Span { first: number; last: number; start: number; end: number; chapter: string }
interface Manifest { book: Omit<Book, 'text'|'segments'|'remote'> & {remote?: Omit<NonNullable<Book['remote']>, 'cache'>}; segments: Page[]; chapters: Page[]; count: number; cacheCount: number; spans: Span[]; }
const verified = new WeakSet<Book>();
const remoteLayouts=new WeakMap<Book,{ends:number[];lastFetchedAt:string|null}>();
export const remoteLayout=(book:Book)=>remoteLayouts.get(book);
const spansByBook = new WeakMap<Book, Span[]>();
export const isPagedBook = (book: Book) => verified.has(book);
export function chapterSpan(book: Book, index: number) { return spansByBook.get(book)?.find(s => s.first <= index && index <= s.last); }
export function readerChapters(book:Book){const saved=spansByBook.get(book);if(saved)return saved.map(s=>({title:s.chapter,segment:s.first}));const result:Array<{title:string;segment:number}>=[];for(let i=0;i<book.segments.length;i++){const s=book.segments[i];if(i===0||s.chapter!==book.segments[i-1].chapter)result.push({title:s.chapter,segment:i});}return result;}
export function chapterEndIds(book:Book):Set<number>{
  const remote=remoteLayouts.get(book);if(remote)return new Set(remote.ends.map(end=>end-1));
  const spans=spansByBook.get(book);if(spans)return new Set(spans.filter(s=>s.chapter!=='正文'||book.segments.length===1).map(s=>s.last));
  const ends=new Set<number>();for(let i=0;i<book.segments.length;i++)if((book.segments[i].chapter!=='正文'||book.segments.length===1)&&(i===book.segments.length-1||book.segments[i+1].chapter!==book.segments[i].chapter))ends.add(i);return ends;
}
/** A single budget shared by every book and both indexes. Values are never attached to the virtual array. */
export class PageCache {
  private pages = new Map<string, {rows: unknown[]; bytes: number}>();
  bytes = 0; reads = 0;
  constructor(readonly limit = 4 * 1024 * 1024) {}
  get(key: string, load: () => {rows: unknown[]; bytes: number}) {
    let item = this.pages.get(key);
    if(item) this.pages.delete(key); else { item=load(); this.reads++; if(item.bytes>this.limit)return item.rows;this.bytes+=item.bytes; }
    this.pages.set(key,item);
    while(this.bytes>this.limit && this.pages.size>1){const key=this.pages.keys().next().value!;this.bytes-=this.pages.get(key)!.bytes;this.pages.delete(key);}
    return item.rows;
  }
  clear(){this.pages.clear();this.bytes=0;}
  stats(){return {bytes:this.bytes,pages:this.pages.size,reads:this.reads,limit:this.limit};}
}
function readAt(file:string,offset:number,size:number){const fd=openSync(file,'r');try{const bytes=Buffer.alloc(size);let at=0;while(at<size){const n=readSync(fd,bytes,at,size-at,offset+at);if(!n)throw Error('Truncated paged book');at+=n;}return bytes;}finally{closeSync(fd);}}
export function fileHash(file:string){const fd=openSync(file,'r'),hash=createHash('sha256');try{const buf=Buffer.alloc(256*1024);let n;while((n=readSync(fd,buf,0,buf.length,null)))hash.update(buf.subarray(0,n));return hash.digest('hex');}finally{closeSync(fd);}}
export function pagedFile(file:string){return statSync(file).size>=MAGIC.length&&readAt(file,0,MAGIC.length).toString()===MAGIC;}
export function writePagedBook(dir:string,book:Book){  const {segments,remote}=book;
  const metadata=Object.fromEntries(Object.keys(book).filter(key=>!['text','segments','remote'].includes(key)).map(key=>[key,book[key as keyof Book]])) as unknown as Manifest['book'];
  return writePagedStream(dir,()=>metadata,segments,remote);
}
/** Keep just one index page while the producer computes final hashes and counts. */
export function writePagedStream(dir:string,metadata:()=>Manifest['book'],segments:Iterable<Segment>,remote?:Book['remote']){
  const temporary=dir+'/'+randomUUID()+'.tmp',fd=openSync(temporary,'wx');let offset=0;
  const write=(b:Buffer)=>{let at=0;while(at<b.length)at+=writeSync(fd,b,at,b.length-at);offset+=b.length;};
  const page=(rows:unknown[]):Page=>{const raw=Buffer.from(JSON.stringify(rows));if(raw.length>MAX_PAGE)throw Error('Book page oversized');const compressed=gzipSync(raw),p={offset,size:compressed.length,hash:sha(raw),count:rows.length};write(compressed);return p;};
  const manifest:Manifest={book:{} as Manifest['book'],segments:[],chapters:[],count:0,cacheCount:remote?.cache.length??0,spans:[]};
  try{
    write(Buffer.from(MAGIC));let rows:Segment[]=[];
    for(const s of segments){
      if(s.id!==manifest.count||manifest.count>=200000)throw Error('Book has too many or inconsistent chapter ranges (maximum 200000)');manifest.count++;
      const previous=manifest.spans.at(-1);if(previous?.chapter===s.chapter){previous.last=s.id;previous.end=s.end;}else manifest.spans.push({first:s.id,last:s.id,start:s.start,end:s.end,chapter:s.chapter});
      rows.push(s);if(rows.length===PAGE_SIZE){manifest.segments.push(page(rows));rows=[];}
    }
    if(rows.length)manifest.segments.push(page(rows));
    for(const chapter of remote?.cache??[])manifest.chapters.push(page([chapter]));
    manifest.book={...metadata(),...(remote?{remote:{catalog:remote.catalog,...(remote.serial?{serial:remote.serial}:{}),...(remote.lastError?{lastError:remote.lastError}:{})}}:{})};
    const json=Buffer.from(JSON.stringify(manifest));if(json.length>MAX_MANIFEST)throw Error('Book manifest oversized');write(json);const footer=Buffer.alloc(8);footer.writeBigUInt64LE(BigInt(json.length));write(footer);fsyncSync(fd);
  }catch(error){closeSync(fd);unlinkSync(temporary);throw error;}closeSync(fd);
  try{const id=fileHash(temporary),target=dir+'/'+id+'.json.gz';if(existsSync(target))unlinkSync(temporary);else renameSync(temporary,target);return id;}finally{if(existsSync(temporary))unlinkSync(temporary);}
}
function readManifest(file:string):{manifest:Manifest;size:number} {
  const size=statSync(file).size;if(size<18)throw Error('Truncated book');const length=Number(readAt(file,size-8,8).readBigUInt64LE());
  if(!Number.isSafeInteger(length)||length<2||length>MAX_MANIFEST||length>size-18)throw Error('Invalid book manifest');
  return { manifest: JSON.parse(readAt(file,size-8-length,length).toString('utf8')) as Manifest, size };
}
/** Append only: old compressed page bytes are copied unchanged; at most the last partial segment page is recompressed. */
export function appendPagedBook(dir:string,baseFile:string,book:Book,newSegments:Segment[],newChapters:CachedChapter[]):{id:string} {
  const remote=book.remote;if(!remote)throw Error('Append requires a remote book');
  const {manifest:base}=readManifest(baseFile);
  const temporary=dir+'/'+randomUUID()+'.tmp',fd=openSync(temporary,'wx');let offset=0;
  const write=(b:Buffer)=>{let at=0;while(at<b.length)at+=writeSync(fd,b,at,b.length-at);offset+=b.length;};
  const segments:Page[]=[],chapters:Page[]=[];
  const page=(rows:unknown[],count=rows.length):Page=>{const raw=Buffer.from(JSON.stringify(rows));if(raw.length>MAX_PAGE)throw Error('Book page oversized');const compressed=gzipSync(raw);const p={offset,size:compressed.length,hash:sha(raw),count};write(compressed);return p;};
  try{
    write(Buffer.from(MAGIC));
    const partial=base.count>0&&base.count%PAGE_SIZE!==0?base.segments.at(-1):undefined;
    const copiedSegments=partial?base.segments.slice(0,-1):base.segments;
    for(const p of copiedSegments){const bytes=readAt(baseFile,p.offset,p.size);const at=offset;write(bytes);segments.push({...p,offset:at});}
    const pending:Segment[]=partial?JSON.parse(gunzipSync(readAt(baseFile,partial.offset,partial.size),{maxOutputLength:MAX_PAGE}).toString('utf8')) as Segment[]:[];
    for(const segment of newSegments){pending.push(segment);if(pending.length===PAGE_SIZE){segments.push(page(pending));pending.length=0;}}
    if(pending.length)segments.push(page(pending));
    for(const p of base.chapters){const bytes=readAt(baseFile,p.offset,p.size);const at=offset;write(bytes);chapters.push({...p,offset:at});}
    for(const chapter of newChapters)chapters.push(page([chapter],1));
    const spans=base.spans.map((span)=>({...span}));
    for(const segment of newSegments){const last=spans.at(-1);if(last&&last.chapter===segment.chapter){last.last=segment.id;last.end=segment.end;}else spans.push({first:segment.id,last:segment.id,start:segment.start,end:segment.end,chapter:segment.chapter});}
    const metadata=Object.fromEntries(Object.keys(book).filter((key)=>!['text','segments','remote'].includes(key)).map((key)=>[key,book[key as keyof Book]])) as unknown as Manifest['book'];
    const manifest:Manifest={book:{...metadata,remote:{catalog:remote.catalog,...(remote.serial?{serial:remote.serial}:{}),...(remote.lastError?{lastError:remote.lastError}:{})}},
      segments,chapters,count:base.count+newSegments.length,cacheCount:base.cacheCount+newChapters.length,spans};
    const json=Buffer.from(JSON.stringify(manifest));if(json.length>MAX_MANIFEST)throw Error('Book manifest oversized');write(json);const footer=Buffer.alloc(8);footer.writeBigUInt64LE(BigInt(json.length));write(footer);fsyncSync(fd);
  }catch(error){closeSync(fd);unlinkSync(temporary);throw error;}closeSync(fd);
  try{const id=fileHash(temporary),target=dir+'/'+id+'.json.gz';if(existsSync(target))unlinkSync(temporary);else renameSync(temporary,target);return {id};}finally{if(existsSync(temporary))unlinkSync(temporary);}
}
export function loadPagedBook(file:string,id:string,cache:PageCache, validatedLocal?:{size:number;mtimeMs:number}):Book {  // Only the in-process import worker can supply this receipt. Disk restore/open always revalidate.
  const trusted=!!validatedLocal;
  if(validatedLocal){const st=statSync(file);if(st.size!==validatedLocal.size||st.mtimeMs!==validatedLocal.mtimeMs)throw Error('Validated import changed');}
  else if(fileHash(file)!==id)throw Error('Book blob checksum mismatch');
  const size=statSync(file).size;if(size<18)throw Error('Truncated book');const length=Number(readAt(file,size-8,8).readBigUInt64LE());
  if(!Number.isSafeInteger(length)||length<2||length>MAX_MANIFEST||length>size-18)throw Error('Invalid book manifest');
  const manifest=JSON.parse(readAt(file,size-8-length,length).toString('utf8')) as Manifest;
  if(!manifest.book||!Number.isSafeInteger(manifest.count)||manifest.count<0||manifest.count>200000||!Number.isSafeInteger(manifest.cacheCount)||manifest.cacheCount<0||manifest.cacheCount>20000||!Array.isArray(manifest.segments)||manifest.segments.length!==Math.ceil(manifest.count/PAGE_SIZE)||!Array.isArray(manifest.chapters)||manifest.chapters.length!==manifest.cacheCount||!Array.isArray(manifest.spans)||manifest.spans.length>200000)throw Error('Invalid paged book index');
  let expectedOffset=MAGIC.length;
  for(const [i,p]of [...manifest.segments,...manifest.chapters].entries()){
    const count=i<manifest.segments.length?Math.min(PAGE_SIZE,manifest.count-i*PAGE_SIZE):1;
    if(p.offset!==expectedOffset||!Number.isSafeInteger(p.size)||p.size<1||p.size>MAX_PAGE||p.count!==count||!/^[a-f0-9]{64}$/.test(p.hash))throw Error('Invalid book page location');expectedOffset+=p.size;
  }
  if(expectedOffset!==size-8-length)throw Error('Invalid book page coverage');
  const load=(p:Page)=>{const raw=gunzipSync(readAt(file,p.offset,p.size),{maxOutputLength:MAX_PAGE});if(sha(raw)!==p.hash)throw Error('Book page checksum mismatch');const rows=JSON.parse(raw.toString('utf8'));if(!Array.isArray(rows)||rows.length!==p.count)throw Error('Invalid book page rows');return {rows,bytes:raw.length*2+rows.length*256};};
  // Validate source identity and contiguous Unicode ranges with one page live at a time.
  let chars=0,bytes=0,index=0;const source=createHash('sha256'),revision=createHash('sha256').update('1\n');const spans:Span[]=[];
  if(!trusted)for(const p of manifest.segments){const rows=load(p).rows as Segment[];for(const s of rows){if(!s||Object.keys(s).length!==5||s.id!==index++||typeof s.chapter!=='string'||s.chapter.length>200||typeof s.text!=='string'||!s.text.length||/[\x00-\x08\x0b\x0c\x0e-\x1f\r]/.test(s.text)||s.start!==chars||Array.from(s.text).length>1200||s.end!==s.start+Array.from(s.text).length)throw Error('Invalid paged segment');chars=s.end;bytes+=Buffer.byteLength(s.text);source.update(s.text);revision.update(s.text);const previous=spans.at(-1);if(previous?.chapter===s.chapter){previous.last=s.id;previous.end=s.end;}else spans.push({first:s.id,last:s.id,start:s.start,end:s.end,chapter:s.chapter});}}
  const b=manifest.book;
  const serial=b.remote?.serial as SerialRecord|undefined;
  if(!trusted&&(bytes>100*1024*1024||chars!==b.totalChars||(!serial&&source.digest('hex')!==b.sourceHash)||b.parserVersion!==1||typeof b.title!=='string'||!b.title.trim()||b.title.length>200||typeof b.author!=='string'||b.author.length>100||b.key!==b.id+':'+b.revision||JSON.stringify(spans)!==JSON.stringify(manifest.spans)))throw Error('Paged book content is inconsistent');
  if(!trusted&&!b.remote&&(sha(b.title.normalize('NFC')+'\n'+b.author.normalize('NFC'))!==b.id||revision.digest('hex')!==b.revision||typeof b.filename!=='string'||!/^([^\\/\x00-\x1f]+)\.(txt|md|epub)$/i.test(b.filename)))throw Error('Paged book identity mismatch');
  function virtual<T>(count:number,pages:Page[],width:number):T[]{return new Proxy(new Array<T>(count),{get(target,key,receiver){if(typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key)){const n=Number(key);if(n>=count)return undefined;const p=pages[Math.floor(n/width)];return cache.get(id+':'+p.offset,()=>load(p))[n%width];}return Reflect.get(target,key,receiver);},has(target,key){return typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key)?Number(key)<count:Reflect.has(target,key);},set(){throw Error('Book pages are immutable');}});}
  const segments=virtual<Segment>(manifest.count,manifest.segments,PAGE_SIZE);
  const book={...b,segments} as Book;
  if(b.remote)book.remote={...b.remote,cache:virtual<CachedChapter>(manifest.cacheCount,manifest.chapters,1)};
  if(!book.remote&&!trusted){
    if(!manifest.count||segments[0].text!==segments[0].text.trimStart()||segments[manifest.count-1].text!==segments[manifest.count-1].text.trimEnd())throw Error('Noncanonical source whitespace');
    const chunks=function*(){for(const segment of segments)yield segment.text;};let index=0;
    for(const expected of streamIndex(chunks)){const actual=segments[index++];if(!actual||actual.id!==expected.id||actual.chapter!==expected.chapter||actual.start!==expected.start||actual.end!==expected.end||actual.text!==expected.text)throw Error('Canonical segment index mismatch');}
    if(index!==manifest.count)throw Error('Canonical segment count mismatch');
  }
  if(book.remote){
    const remote=book.remote;
    if(serial){
      const identity=stableSerialIdentity(serial.serialId,serial.editionEpoch);
      if(book.key!==identity.key||book.id!==identity.id||book.revision!==identity.revision)throw Error('Serial book identity mismatch');
      validateSerialCatalog(remote.catalog,{bookUrl:serial.bookUrl});
      if(remote.catalog.title!==book.title||remote.catalog.author!==book.author||manifest.cacheCount!==serial.layout.length)throw Error('Serial book catalog mismatch');
      validateSerialRecord(serial,manifest.cacheCount,manifest.count);
      const hashes:string[]=[];let chapterIndex=0;for(const chapter of remote.cache){if(chapter.index!==chapterIndex++)throw Error('Noncontiguous serial cache');hashes.push(chapter.hash);}
      if(chapterIndex!==manifest.cacheCount||serialContentHash(hashes)!==book.sourceHash)throw Error('Serial content digest mismatch');
      remoteLayouts.set(book,{ends:[...serial.layout],lastFetchedAt:remote.cache.at(-1)?.fetchedAt??null});
    } else {
      const base=buildRemoteBook({catalog:remote.catalog,cache:[]});
      if(base.key!==book.key||base.title!==book.title||base.author!==book.author||manifest.cacheCount>remote.catalog.chapters.length)throw Error('Remote book identity mismatch');
      let segmentId=0,offset=0,lastFetchedAt:string|null=null;const ends:number[]=[];
      let chapterIndex=0;for(const chapter of remote.cache){
        if(chapter.index!==chapterIndex++)throw Error('Noncontiguous remote cache');
        const number=remote.catalog.chapters[chapter.index];if(!number)throw Error('Invalid remote chapter index');
        const catalog={...remote.catalog,declaredTotal:1,chapters:[number]};catalog.hash=catalogHash(catalog);
        const rebuilt=buildRemoteBook({catalog,cache:[{...chapter,index:0}]});
        for(const part of rebuilt.segments){const actual=segments[segmentId];if(!actual||actual.id!==segmentId||actual.chapter!==part.chapter||actual.text!==part.text||actual.start!==offset+part.start||actual.end!==offset+part.end)throw Error('Remote segment index mismatch');segmentId++;}
        offset+=rebuilt.totalChars;ends.push(segmentId);lastFetchedAt=chapter.fetchedAt;
      }
      remoteLayouts.set(book,{ends,lastFetchedAt});
      if(segmentId!==manifest.count)throw Error('Remote cache coverage mismatch');
    }
    if(remote.lastError){const e=remote.lastError;if(!['unsupported','needs_login','restricted','missing','temporary','invalid_content','limit','cancelled'].includes(e.code)||typeof e.message!=='string'||e.message.length>500||!Number.isFinite(Date.parse(e.at))||e.chapterIndex!==remote.cache.length)throw Error('Invalid source error record');}
  }
  Object.defineProperty(book,'text',{enumerable:true,get(){let text='';for(const segment of segments)text+=segment.text;return text;}});
  verified.add(book);spansByBook.set(book,trusted?manifest.spans:spans);return book;
}
