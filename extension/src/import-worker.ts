import {detectImportMetadata} from './import-metadata.ts';
import { parentPort, workerData } from 'node:worker_threads';
import { statSync,openSync,readSync,closeSync } from 'node:fs';
import { join } from 'node:path';
import { importFileBlob } from './stream-import.ts';
import { loadPagedBook, PageCache } from './paged-book.ts';
let last=0;const report=(stage:string,done:number,total:number,force=false)=>{const now=Date.now();if(force||now-last>=100){last=now;parentPort!.postMessage({type:'progress',stage,done,total});}};
try{
  const {dir,file,metadata}=workerData;
  let actualMetadata=metadata;if(metadata.autoMetadata===true){const fd=openSync(file,'r');try{const prefix=Buffer.alloc(16*1024),n=readSync(fd,prefix,0,prefix.length,0);actualMetadata={...metadata,...detectImportMetadata(metadata.filename,new TextDecoder('utf-8').decode(prefix.subarray(0,n)))};}finally{closeSync(fd);}}
  const id=importFileBlob(dir,file,actualMetadata,16*1024,(stage,n,total)=>report(stage,n,total));
  report('validate',0,1,true);const output=join(dir,id+'.json.gz');loadPagedBook(output,id,new PageCache());
  const st=statSync(output);parentPort!.postMessage({type:'done',id,receipt:{size:st.size,mtimeMs:st.mtimeMs}});
}catch(error){parentPort!.postMessage({type:'error',error:error instanceof Error?error.message:String(error)});}
