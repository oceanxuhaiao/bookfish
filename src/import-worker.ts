import {detectImportMetadata} from './import-metadata.ts';
import {parseEpub} from './epub.ts';
import {parsePdf} from './pdf.ts';
import { parentPort, workerData } from 'node:worker_threads';
import { statSync,openSync,readSync,closeSync,readFileSync,writeFileSync,unlinkSync,existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { importFileBlob } from './stream-import.ts';
import { loadPagedBook, PageCache } from './paged-book.ts';
let last=0;const report=(stage:string,done:number,total:number,force=false)=>{const now=Date.now();if(force||now-last>=100){last=now;parentPort!.postMessage({type:'progress',stage,done,total});}};

async function run(){
  const {dir,file,metadata}=workerData;
  let actualMetadata=metadata;let sourceFile=file;let temp:string|undefined;
  try{
    const name=String(metadata.filename??'');
    if(/\.epub$/i.test(name)||/\.epub$/i.test(file)){
      // EPUB is a ZIP container: convert it to canonical Markdown locally, then
      // reuse the exact same normalization/index pipeline as TXT/Markdown.
      const book=parseEpub(readFileSync(file));
      actualMetadata={...metadata};
      if(book.title&&(metadata.autoMetadata===true||!actualMetadata.title))actualMetadata.title=book.title;
      if(book.author&&!actualMetadata.author)actualMetadata.author=book.author;
      temp=join(dir,randomUUID()+'.epub.md');writeFileSync(temp,book.markdown,'utf8');sourceFile=temp;
    }else if(/\.pdf$/i.test(name)||/\.pdf$/i.test(file)){
      // PDF: extract the text layer, rebuild paragraphs and chapter headings.
      const book=await parsePdf(new Uint8Array(readFileSync(file)));
      actualMetadata={...metadata};
      if(book.title&&(metadata.autoMetadata===true||!actualMetadata.title))actualMetadata.title=book.title;
      if(book.author&&!actualMetadata.author)actualMetadata.author=book.author;
      temp=join(dir,randomUUID()+'.pdf.md');writeFileSync(temp,book.markdown,'utf8');sourceFile=temp;
    }else if(metadata.autoMetadata===true){
      const fd=openSync(file,'r');try{const prefix=Buffer.alloc(16*1024),n=readSync(fd,prefix,0,prefix.length,0);actualMetadata={...metadata,...detectImportMetadata(metadata.filename,new TextDecoder('utf-8').decode(prefix.subarray(0,n)))};}finally{closeSync(fd);}
    }
    const id=importFileBlob(dir,sourceFile,actualMetadata,16*1024,(stage,n,total)=>report(stage,n,total));
    report('validate',0,1,true);const output=join(dir,id+'.json.gz');loadPagedBook(output,id,new PageCache());
    const st=statSync(output);parentPort!.postMessage({type:'done',id,receipt:{size:st.size,mtimeMs:st.mtimeMs}});
  }finally{if(temp&&existsSync(temp))unlinkSync(temp);}
}
run().catch(error=>parentPort!.postMessage({type:'error',error:error instanceof Error?error.message:String(error)}));
