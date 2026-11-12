import {detectImportMetadata} from './import-metadata.ts';
import { ImportJob, cleanImportDirectory } from './import-job.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeSync, fsyncSync, unlinkSync, existsSync, statSync, readdirSync, readSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_BOOK_BYTES, requiredText } from './books.ts';
import type { Library } from './library.ts';
const CHUNK=256*1024,TTL=15*60000,MAX_BACKUP=1024*1024*1024;
interface Transfer {id:string;file:string;size:number;offset:number;expires:number;kind:'book'|'backup'|'download';filename?:string;title?:string;author?:unknown;autoMetadata?:boolean;last?:{offset:number;base64:string}}
/** Bounded per-World transfer, with contiguous offsets and retry-safe last chunks. */
export class BookTransfers {
  private active?:Transfer;
  private job?:ImportJob;
  private timer?:ReturnType<typeof setTimeout>;
  private cleanStale(){mkdirSync(this.dir,{recursive:true});for(const name of readdirSync(this.dir)){if(/^[a-f0-9-]{36}\.(part|backup)$/.test(name)&&name!==this.active?.id+'.part'&&name!==this.active?.id+'.backup')unlinkSync(join(this.dir,name));}}
  private arm(){if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>this.close(),TTL);this.timer.unref?.();}
  private readonly dir:string;
  constructor(private lib:Library,private now:()=>number=Date.now){this.dir=join(lib.dir,'transfers');}
  close(){if(this.job?.status.state==='processing'){void this.job.cancel();return;}if(this.timer)clearTimeout(this.timer);this.timer=undefined;const a=this.active;this.active=undefined;if(a&&existsSync(a.file))unlinkSync(a.file);}
  recover(){
    if(this.job?.status.state==='processing')throw Error('Import is running');
    this.cleanStale();for(const name of readdirSync(this.dir)){if(/^[a-f0-9-]{36}\.import$/.test(name))cleanImportDirectory(this.dir,name);}
  }
  async shutdown(){await this.job?.cancel();this.close();}
  status(id?:unknown){if(id!==undefined&&id!==this.job?.id)throw Error('Import task not found');return this.job?structuredClone(this.job.status):null;}
  start(id:unknown){
    if(this.job&&this.job.id===id)return this.status(id);
    const a=this.require(id);if(a.kind==='backup')return {state:'done',result:this.finish(id)};
    if(a.kind!=='book'||a.offset!==a.size)throw Error('Upload is incomplete');
    if(this.job?.id===id)return this.status(id);
    a.last=undefined;
    this.job=new ImportJob(this.dir,a.id,a.file,{filename:a.filename,title:a.title,author:a.author,autoMetadata:a.autoMetadata},(file,hash,receipt)=>this.lib.adoptValidatedImport(file,hash,receipt),()=>{if(existsSync(a.file))unlinkSync(a.file);if(this.active===a)this.active=undefined;if(this.job?.id===a.id){if(this.timer)clearTimeout(this.timer);this.timer=undefined;}});
    return this.status(id);
  }
  private require(id:unknown){const a=this.active;if(!a||id!==a.id||this.now()>a.expires){if(a&&this.now()>a.expires)this.close();throw Error('Transfer expired or cancelled');}a.expires=this.now()+TTL;this.arm();return a;}
  begin(input:unknown){
    if(this.job&&['processing','committing'].includes(this.job.status.state))throw Error('An import is already running');
    if(!input||typeof input!=='object')throw Error('Invalid upload');const v=input as Record<string,unknown>;
    const kind=v.kind==='backup'?'backup':'book';const size=v.size;
    if(!Number.isSafeInteger(size)||(size as number)<1||(size as number)>(kind==='book'?MAX_BOOK_BYTES:MAX_BACKUP))throw Error(kind==='book'?'Novel must be 1 byte—100 MiB':'Backup must be at most 1 GiB');
    if(kind==='backup'&&this.lib.list().length)throw Error('Restore requires an empty library');
    if(v.author!==undefined&&(typeof v.author!=='string'||v.author.length>100))throw Error('Invalid author');
    const filename=requiredText(v.filename,'filename');if(v.autoMetadata!==undefined&&typeof v.autoMetadata!=='boolean')throw Error('Invalid metadata mode');const title=kind==='book'?(v.autoMetadata===true?detectImportMetadata(filename).title:requiredText(v.title,'title')):undefined;
    if(kind==='backup'&&/\.json$/i.test(filename)&&(size as number)>25*1024*1024)throw Error('Use .bfbak for backups larger than 25 MiB');
    if(kind==='book'&&filename&&(/[\\/\x00-\x1f]/.test(filename)||! /\.(txt|md|epub|pdf)$/i.test(filename)))throw Error('Only .txt, .md, .epub or .pdf novels are supported');
    this.close();this.job=undefined;this.cleanStale();const id=randomUUID(),file=join(this.dir,id+'.part');closeSync(openSync(file,'wx'));
    this.active={id,file,size:size as number,offset:0,expires:this.now()+TTL,kind,filename,title,author:v.author,autoMetadata:v.autoMetadata===true};this.arm();return {id,chunkBytes:CHUNK};
  }
  chunk(id:unknown,offset:unknown,base64:unknown){
    const a=this.require(id);if(this.job?.id===id)throw Error('Import already started');if(a.kind==='download')throw Error('Not an upload');
    if(typeof base64!=='string'||base64.length>Math.ceil(CHUNK/3)*4||!Number.isSafeInteger(offset))throw Error('Invalid upload chunk');
    if(a.last&&a.last.offset===offset&&a.last.base64===base64)return {offset:a.offset};
    if(offset!==a.offset)throw Error('Upload offset mismatch');const bytes=Buffer.from(base64,'base64');
    if(!bytes.length||bytes.length>CHUNK||bytes.toString('base64')!==base64||a.offset+bytes.length>a.size)throw Error('Invalid upload data');
    const fd=openSync(a.file,'r+');try{let p=0;while(p<bytes.length)p+=writeSync(fd,bytes,p,bytes.length-p,a.offset+p);}finally{closeSync(fd);}a.last={offset:a.offset,base64};a.offset+=bytes.length;return {offset:a.offset};
  }
  finish(id:unknown){const a=this.require(id);if(a.kind==='download'||a.offset!==a.size)throw Error('Upload is incomplete');
    try{const fd=openSync(a.file,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}
      return a.kind==='book'?this.lib.importFile({filename:a.filename,title:a.title,author:a.author},a.file):
        /\.json$/i.test(a.filename??'')?this.lib.restore(readFileSync(a.file,'utf8')):this.lib.restoreArchive(a.file);
    }finally{this.close();}}
  cancel(id:unknown){if(this.job&&this.job.id===id)return this.job.cancel().then(()=>({cancelled:this.job?.status.state==='cancelled'}));this.require(id);this.close();return {cancelled:true};}
  download(){if(this.job&&['processing','committing'].includes(this.job.status.state))throw Error('Wait for the import to complete');this.close();mkdirSync(this.dir,{recursive:true});const id=randomUUID(),file=join(this.dir,id+'.backup');try{const {size}=this.lib.writeArchive(file);if(size>MAX_BACKUP)throw Error('Backup exceeds 1 GiB transfer limit');this.active={id,file,size,offset:0,expires:this.now()+TTL,kind:'download'};this.arm();return {id,size,chunkBytes:CHUNK};}catch(e){if(existsSync(file))unlinkSync(file);throw e;}}
  read(id:unknown,offset:unknown){const a=this.require(id);if(a.kind!=='download'||!Number.isSafeInteger(offset)||(offset as number)<0||(offset as number)>a.size)throw Error('Invalid backup range');const bytes=Buffer.alloc(Math.min(CHUNK,a.size-(offset as number))),fd=openSync(a.file,'r');try{const n=readSync(fd,bytes,0,bytes.length,offset as number);return {base64:bytes.subarray(0,n).toString('base64'),nextOffset:(offset as number)+n,done:(offset as number)+n===a.size};}finally{closeSync(fd);}}
}
