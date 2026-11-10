import { createRequire } from 'node:module';
import type { DatabaseSync as Database } from 'node:sqlite';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { createHash } from 'node:crypto';
import { statSync, existsSync } from 'node:fs';
import type { ReadingTask } from './library.ts';
import type { ReadingEpisode } from './journal.ts';
type Row = ReadingTask | ReadingEpisode;
type Kind = 'tasks'|'episodes';
export interface HistoryRef {version:number;tasks:number;episodes:number;sum:string}
export interface HistoryFilter {id?:unknown;bookKey?:unknown;status?:string;kind?:string;requestId?:string;taskId?:string;revises?:string;before?:number;hasMood?:boolean}
const MAX_DB=512*1024*1024,MAX_ROW=64*1024,MOD=1n<<256n;
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const add=(a:bigint,b:bigint)=>(a+b+MOD)%MOD;
const views=new WeakMap<object,View<any>>(),mutableRows=new WeakMap<object,()=>Row>();
const column=(r:any)=>[r.id,r.bookKey,r.segmentId??-1,r.sequence??-1,r.status??r.kind,r.requestId??null,r.taskId??null,r.revises??null,r.content?.mood?1:0];
const visibility='v<=? AND (until_v IS NULL OR until_v>?)';
export function isHistory(v:unknown):boolean{return !!v&&typeof v==='object'&&views.has(v);}
export function historyFork<T>(rows:T[]):T[]{return views.get(rows)?.fork()??structuredClone(rows);}
export function historySelect<T extends Row>(rows:readonly T[],filter:HistoryFilter={}):T[]{const view=views.get(rows);if(view)return view.select(filter);return (rows as T[]).filter(r=>matches(r,filter));}
function matches(r:any,f:HistoryFilter){return Object.entries(f).every(([k,v])=>k==='before'?(r.sequence??r.segmentId)<v!:k==='hasMood'?!!r.content?.mood===v:k==='kind'?r.kind===v:r[k]===v);}
export function historyCount<T extends Row>(rows:readonly T[],filter:HistoryFilter={}):number{const view=views.get(rows);return view?view.count(filter):historySelect(rows,filter).length;}
export function historyPage<T extends Row>(rows:readonly T[],filter:HistoryFilter,limit:number):T[]{const view=views.get(rows);return view?view.page(filter,limit):historySelect(rows,filter).sort((a:any,b:any)=>(b.sequence??b.segmentId)-(a.sequence??a.segmentId)).slice(0,limit);}
export function historyFind<T extends Row>(rows:readonly T[],filter:HistoryFilter):T|undefined{return historySelect(rows,filter)[0];}
export function plainHistory<T>(value:T):T{
 if(value&&typeof value==='object'){const unwrap=mutableRows.get(value);if(unwrap)return structuredClone(unwrap()) as T;if(Array.isArray(value))return Array.from(value,plainHistory) as T;return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,plainHistory(v)])) as T;}return value;
}
class View<T extends Row>{
 readonly array:T[];changes:Map<number,T>;next:number;
 constructor(readonly store:HistoryStore,readonly kind:Kind,readonly version:number,public order:number[],readonly mutable=false,changes=new Map<number,T>(),next?:number,readonly scoped=false){
  this.changes=changes;this.next=next??store.maximum(kind)+1;
  this.array=new Proxy(new Array<T>(order.length),{
   get:(target,key,receiver)=>{
    if(key==='length')return this.order.length;
    if(key==='push')return (...items:T[])=>{if(!mutable)throw Error('Read-only history');for(const item of items){const n=this.next++;this.order.push(n);this.changes.set(n,structuredClone(plainHistory(item)));}return this.order.length;};
    if(key==='filter')return (predicate:(r:T,i:number)=>boolean)=>this.sub(this.order.filter((n,i)=>predicate(this.row(n),i)));
    if(key==='slice')return (start?:number,end?:number)=>this.sub(this.order.slice(start,end));
    if(key==='reverse')return ()=>{this.order=[...this.order].reverse();return this.array;};
    if(key==='sort')return (compare:(a:T,b:T)=>number)=>{this.order=[...this.order].sort((a,b)=>compare(this.row(a),this.row(b)));return this.array;};
    if(typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key)){const n=this.order[Number(key)];return n===undefined?undefined:this.row(n);}
    return Reflect.get(target,key,receiver);
   },has:(target,key)=>typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key)?Number(key)<this.order.length:Reflect.has(target,key),set:()=>{throw Error('History array cannot be assigned directly');}
  });views.set(this.array,this);
 }
 private sub(order:number[]){return new View<T>(this.store,this.kind,this.version,order,this.mutable,this.changes,this.next,true).array;}
 fork(){return new View<T>(this.store,this.kind,this.version,[...this.order],true,new Map(Array.from(this.changes,([n,row])=>[n,structuredClone(row)])),this.next).array;}
 raw(n:number):T{return this.changes.get(n)??this.store.row(this.kind,this.version,n) as T;}
 row(n:number):T{
  if(!this.mutable)return this.raw(n);
  const proxy=new Proxy({} as T,{get:(_t,k)=>Reflect.get(this.raw(n),k),ownKeys:()=>Reflect.ownKeys(this.raw(n)),getOwnPropertyDescriptor:(_t,k)=>{const p=Object.getOwnPropertyDescriptor(this.raw(n),k);return p?{...p,configurable:true}:undefined;},set:(_t,k,v)=>{let copy=this.changes.get(n);if(!copy){copy=structuredClone(this.raw(n));this.changes.set(n,copy);}Reflect.set(copy,k,v);return true;}});mutableRows.set(proxy,()=>this.raw(n));return proxy;
 }
 count(filter:HistoryFilter){return this.mutable||this.scoped?this.select(filter).length:this.store.positions(this.kind,this.version,filter,-1)[0];}
 page(filter:HistoryFilter,limit:number):T[]{if(this.mutable)return this.select(filter).reverse().slice(0,limit);return this.sub(this.store.positions(this.kind,this.version,filter,limit));}
 select(filter:HistoryFilter):T[]{
  if(!this.mutable){const found=this.store.positions(this.kind,this.version,filter);const contains=(n:number)=>{if(this.order.length>1&&this.order[0]>this.order.at(-1)!)return this.order.includes(n);let lo=0,hi=this.order.length;while(lo<hi){const mid=(lo+hi)>>>1;if(this.order[mid]<n)lo=mid+1;else hi=mid;}return this.order[lo]===n;};return this.sub(found.filter(contains));}
  const found=new Set(this.store.positions(this.kind,this.version,filter));for(const [n,row]of this.changes){if(matches(row,filter))found.add(n);else found.delete(n);}return this.sub(this.order.filter(n=>found.has(n)));
 }
}
/** MVCC records commit before the JSON pointer, preserving the prior snapshot on a failed metadata write. */
export class HistoryStore{
 private db?:Database;private cache=new Map<string,{rows:Map<number,Row>;bytes:number}>();private cacheBytes=0;private reads=0;
 readonly cacheLimit=2*1024*1024;
 constructor(readonly file:string,readonly readOnly=false){}
 open(){if(this.db)return;if(existsSync(this.file)&&statSync(this.file).size>MAX_DB)throw Error('History database exceeds 512 MiB');this.db=new DatabaseSync(this.file,{readOnly:this.readOnly});this.db.exec('PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;');
  if(!this.readOnly)this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS history(kind TEXT NOT NULL,n INTEGER NOT NULL,v INTEGER NOT NULL,until_v INTEGER,id TEXT NOT NULL,bookKey TEXT NOT NULL,segment INTEGER NOT NULL,sequence INTEGER NOT NULL,state TEXT NOT NULL,requestId TEXT,taskId TEXT,revises TEXT,mood INTEGER NOT NULL,json TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(kind,n,v));
   CREATE INDEX IF NOT EXISTS history_live ON history(kind,n,v,until_v);
   CREATE INDEX IF NOT EXISTS history_live_book ON history(kind,bookKey,n,v,until_v);
   CREATE INDEX IF NOT EXISTS history_future ON history(v);
   CREATE INDEX IF NOT EXISTS history_retired ON history(until_v);
   CREATE INDEX IF NOT EXISTS history_id ON history(kind,id,v);
   CREATE INDEX IF NOT EXISTS history_mood ON history(kind,bookKey,mood,sequence,n,v);
   CREATE INDEX IF NOT EXISTS history_page_episode ON history(kind,bookKey,sequence,n,v);
   CREATE INDEX IF NOT EXISTS history_page_task ON history(kind,bookKey,state,segment,n,v);
   CREATE INDEX IF NOT EXISTS history_book ON history(kind,bookKey,state,sequence,segment,v);
   CREATE INDEX IF NOT EXISTS history_request ON history(kind,requestId,v);
   CREATE INDEX IF NOT EXISTS history_revises ON history(kind,revises,v);
   CREATE INDEX IF NOT EXISTS history_task ON history(kind,taskId,v);
   CREATE TABLE IF NOT EXISTS snapshots(v INTEGER PRIMARY KEY,ref TEXT NOT NULL);`);
 }
 close(){this.clearCache();this.db?.close();this.db=undefined;}
 private get sql(){if(!this.db)throw Error('History store closed');return this.db;}
 clearCache(){this.cache.clear();this.cacheBytes=0;}
 stats(){return {bytes:this.cacheBytes,limit:this.cacheLimit,pages:this.cache.size,reads:this.reads};}
 maximum(kind:Kind){return Number((this.sql.prepare('SELECT COALESCE(MAX(n),-1) AS n FROM history WHERE kind=?').get(kind) as any).n);}
 positions(kind:Kind,version:number,filter:HistoryFilter={},limit?:number):number[]{
  if(Object.values(filter).some(v=>v===undefined||v===null||typeof v==='object'))return [];
  const conditions=['kind=?',visibility],args:any[]=[kind,version,version];const names:Record<string,string>={id:'id',bookKey:'bookKey',status:'state',kind:'state',requestId:'requestId',taskId:'taskId',revises:'revises',hasMood:'mood'};
  for(const [key,value]of Object.entries(filter)){if(key==='before'){conditions.push((kind==='episodes'?'sequence':'segment')+'<?');args.push(value);}else{const name=names[key];if(!name)throw Error('Invalid history filter');conditions.push(name+'=?');args.push(typeof value==='boolean'?Number(value):value);}}
  if(limit===-1)return [Number(this.sql.prepare('SELECT COUNT(*) AS n FROM history WHERE '+conditions.join(' AND ')).get(...args)!.n)];
  return Array.from(this.sql.prepare('SELECT n FROM history WHERE '+conditions.join(' AND ')+(limit===undefined?' ORDER BY n':' ORDER BY '+(kind==='episodes'?'sequence':'segment')+' DESC LIMIT '+limit)).iterate(...args),r=>Number(r.n));
 }
 private decode(r:any):Row{if(typeof r.json!=='string'||Buffer.byteLength(r.json)>MAX_ROW)throw Error('History record oversized');if(sha(r.kind+':'+r.n+':'+r.json)!==r.hash)throw Error('History row checksum mismatch');const row=JSON.parse(r.json);if(JSON.stringify(column(row))!==JSON.stringify([r.id,r.bookKey,r.segment,r.sequence,r.state,r.requestId,r.taskId,r.revises,r.mood]))throw Error('History index mismatch');return row;}
 row(kind:Kind,version:number,n:number):Row{
  const start=Math.floor(n/32)*32,key=kind+':'+version+':'+start;let page=this.cache.get(key);
  if(page){this.cache.delete(key);this.cache.set(key,page);}else{
   const rows=new Map<number,Row>();let bytes=0;for(const r of this.sql.prepare('SELECT * FROM history WHERE kind=? AND n>=? AND n<? AND '+visibility).iterate(kind,start,start+32,version,version)){rows.set(Number(r.n),this.decode(r));bytes+=String(r.json).length*2+512;}
   this.reads++;page={rows,bytes};if(bytes<=this.cacheLimit){this.cache.set(key,page);this.cacheBytes+=bytes;while(this.cacheBytes>this.cacheLimit){const first=this.cache.keys().next().value!;this.cacheBytes-=this.cache.get(first)!.bytes;this.cache.delete(first);}}
  }
  const row=page.rows.get(n);if(!row)throw Error('History record missing');return row;
 }
 hydrate<T extends {tasks:ReadingTask[];episodes:ReadingEpisode[]}>(state:T,ref:HistoryRef):T{
  if(!ref||!Number.isSafeInteger(ref.version)||ref.version<1||!Number.isSafeInteger(ref.tasks)||ref.tasks<0||ref.tasks>250000||!Number.isSafeInteger(ref.episodes)||ref.episodes<0||ref.episodes>100000||!/^[a-f0-9]{64}$/.test(ref.sum))throw Error('Invalid history snapshot reference');
  const saved=this.sql.prepare('SELECT ref FROM snapshots WHERE v=?').get(ref.version);if(!saved||saved.ref!==JSON.stringify(ref))throw Error('History snapshot is missing or inconsistent');
  const oversized=this.sql.prepare('SELECT 1 FROM history WHERE length(CAST(json AS BLOB))>? OR length(id)>80 OR length(bookKey)>150 OR length(requestId)>80 OR length(taskId)>80 OR length(revises)>80 LIMIT 1').get(MAX_ROW);if(oversized)throw Error('History record or index oversized');
  const check=this.sql.prepare('PRAGMA quick_check').get();if(!check||Object.values(check)[0]!=='ok')throw Error('History database is corrupt');let sum=0n,tasks=0,episodes=0;
  for(const r of this.sql.prepare('SELECT * FROM history WHERE '+visibility+' ORDER BY kind,n').iterate(ref.version,ref.version)){this.decode(r);sum=add(sum,BigInt('0x'+r.hash));if(r.kind==='tasks')tasks++;else if(r.kind==='episodes')episodes++;else throw Error('Invalid history kind');}
  if(tasks!==ref.tasks||episodes!==ref.episodes||sum.toString(16).padStart(64,'0')!==ref.sum)throw Error('History snapshot checksum mismatch');
  return {...state,tasks:new View<ReadingTask>(this,'tasks',ref.version,this.positions('tasks',ref.version)).array,episodes:new View<ReadingEpisode>(this,'episodes',ref.version,this.positions('episodes',ref.version)).array};
 }
 prepare(state:{tasks:ReadingTask[];episodes:ReadingEpisode[]},base?:HistoryRef):HistoryRef{
  this.sql.exec('BEGIN IMMEDIATE');try{
   const current=base?.version??0;this.sql.prepare('DELETE FROM history WHERE v>?').run(current);this.sql.prepare('UPDATE history SET until_v=NULL WHERE until_v>?').run(current);this.sql.prepare('DELETE FROM snapshots WHERE v>?').run(current);
   const version=current+1;let sum=base?BigInt('0x'+base.sum):0n;
   const insert=this.sql.prepare('INSERT INTO history VALUES(?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?)');
   for(const kind of ['tasks','episodes'] as const){const rows=state[kind],view=views.get(rows);const oldOrder=base?this.positions(kind,current):[],remaining=new Set(view?.store===this?view.order:[]);
    if(!view||view.store!==this){for(const n of oldOrder){const old=this.sql.prepare('SELECT hash FROM history WHERE kind=? AND n=? AND '+visibility).get(kind,n,current,current)!;sum=add(sum,-BigInt('0x'+String(old.hash)));this.sql.prepare('UPDATE history SET until_v=? WHERE kind=? AND n=? AND '+visibility).run(version,kind,n,current,current);}}
    else for(const n of oldOrder)if(!remaining.has(n)){const old=this.sql.prepare('SELECT hash FROM history WHERE kind=? AND n=? AND '+visibility).get(kind,n,current,current)!;sum=add(sum,-BigInt('0x'+String(old.hash)));this.sql.prepare('UPDATE history SET until_v=? WHERE kind=? AND n=? AND '+visibility).run(version,kind,n,current,current);}
    const allRows=function*():Generator<[number,Row]>{for(let i=0;i<rows.length;i++)yield [i,rows[i]];};
    const changes:Iterable<[number,Row]>=view?.store===this?view.changes:allRows();
    for(const [n,row]of changes){if(view?.store===this&&!remaining.has(n))continue;const json=JSON.stringify(plainHistory(row));if(Buffer.byteLength(json)>MAX_ROW)throw Error('History record oversized');const hash=sha(kind+':'+n+':'+json);const old=this.sql.prepare('SELECT hash FROM history WHERE kind=? AND n=? AND '+visibility).get(kind,n,current,current);if(old){sum=add(sum,-BigInt('0x'+String(old.hash)));this.sql.prepare('UPDATE history SET until_v=? WHERE kind=? AND n=? AND '+visibility).run(version,kind,n,current,current);}
     insert.run(kind,n,version,...column(row),json,hash);sum=add(sum,BigInt('0x'+hash));}
   }
   const ref={version,tasks:state.tasks.length,episodes:state.episodes.length,sum:sum.toString(16).padStart(64,'0')};this.sql.prepare('INSERT INTO snapshots VALUES(?,?)').run(version,JSON.stringify(ref));
   const pages=Number((this.sql.prepare('PRAGMA page_count').get() as any).page_count),size=Number((this.sql.prepare('PRAGMA page_size').get() as any).page_size);if(pages*size>MAX_DB)throw Error('History database exceeds 512 MiB');this.sql.exec('COMMIT');return ref;
  }catch(error){this.sql.exec('ROLLBACK');throw error;}
 }
 committed(ref:HistoryRef){this.sql.prepare('DELETE FROM history WHERE until_v IS NOT NULL AND until_v<=?').run(ref.version);this.sql.prepare('DELETE FROM snapshots WHERE v<?').run(ref.version);this.clearCache();}
 bind<T extends {tasks:ReadingTask[];episodes:ReadingEpisode[]}>(state:T,ref:HistoryRef):T{return {...state,tasks:new View<ReadingTask>(this,'tasks',ref.version,this.positions('tasks',ref.version)).array,episodes:new View<ReadingEpisode>(this,'episodes',ref.version,this.positions('episodes',ref.version)).array};}
 payloadBytes(ref:HistoryRef){return Number((this.sql.prepare('SELECT COALESCE(SUM(length(CAST(json AS BLOB))),0) AS n FROM history WHERE '+visibility).get(ref.version,ref.version) as any).n);}
 snapshot(file:string){this.sql.exec('VACUUM INTO '+"'"+file.replaceAll("'","''")+"'");if(statSync(file).size>MAX_DB)throw Error('History snapshot oversized');}
}
