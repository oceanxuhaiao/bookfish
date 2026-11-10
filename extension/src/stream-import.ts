import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { openSync, closeSync, readSync, writeSync, ftruncateSync, fsyncSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildBook, MAX_BOOK_BYTES, type Segment } from './books.ts';
import { streamIndex } from './stream-index.ts';
import { writePagedStream } from './paged-book.ts';
const TEXT_ENCODING_ERROR = 'Book must use UTF-8, GB18030 or UTF-16 encoding';
/** Pick a decoder from a bounded prefix; only reject UTF-8 when the failure is not at the chunk tail. */
function textDecoder(prefix: Buffer): TextDecoder {
  if (prefix.length >= 3 && prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf) return new TextDecoder('utf-8', { fatal: true });
  if (prefix.length >= 2 && prefix[0] === 0xff && prefix[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true });
  if (prefix.length >= 2 && prefix[0] === 0xfe && prefix[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true });
  try { new TextDecoder('utf-8', { fatal: true }).decode(prefix, { stream: true }); return new TextDecoder('utf-8', { fatal: true }); } catch { /* not UTF-8 */ }
  try { new TextDecoder('gb18030', { fatal: true }).decode(prefix, { stream: true }); return new TextDecoder('gb18030', { fatal: true }); } catch { /* unsupported */ }
  throw Error(TEXT_ENCODING_ERROR);
}
/** Decode/normalize on disk so even an all-whitespace tail or a newline-free book stays bounded. */
function canonicalize(source:string,target:string,chunkBytes:number,progress?:(done:number,total:number)=>void){
  const size=statSync(source).size;if(!size||size>MAX_BOOK_BYTES)throw Error('Book must be between 1 byte and 100 MiB');
  const input=openSync(source,'r');let output:number;
  try{output=openSync(target,'wx');}catch(error){closeSync(input);throw error;}
  let bytes=0,lastGood=0,offset=0,started=false,pendingCR=false;
  let decoder:TextDecoder;
  const emit=(part:string)=>{
    if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(part))throw Error('Binary or control characters are not supported');
    if(pendingCR){part='\r'+part;pendingCR=false;}
    if(part.endsWith('\r')){part=part.slice(0,-1);pendingCR=true;}
    part=part.replace(/\r\n?/g,'\n');
    if(!started){part=part.trimStart();if(part)started=true;}
    if(!part)return;
    const data=Buffer.from(part),trimmed=part.trimEnd();if(trimmed)lastGood=offset+Buffer.byteLength(trimmed);
    let at=0;while(at<data.length)at+=writeSync(output,data,at,data.length-at);offset+=data.length;
  };
  try{
    const headSize=Math.min(size,64*1024),head=Buffer.alloc(headSize);let n=readSync(input,head,0,headSize,null);
    if(!n)throw Error('Book has no readable text');
    const first=head.subarray(0,n);decoder=textDecoder(first);bytes=n;
    let firstText:string;try{firstText=decoder.decode(first,{stream:true});}catch{throw Error(TEXT_ENCODING_ERROR);}emit(firstText);
    progress?.(bytes,size);
    const buffer=Buffer.alloc(chunkBytes);
    while((n=readSync(input,buffer,0,buffer.length,null))){bytes+=n;if(bytes>MAX_BOOK_BYTES)throw Error('Book exceeds 100 MiB');let text:string;try{text=decoder.decode(buffer.subarray(0,n),{stream:true});}catch{throw Error(TEXT_ENCODING_ERROR);}emit(text);progress?.(bytes,size);}
    let tail:string;try{tail=decoder.decode();}catch{throw Error(TEXT_ENCODING_ERROR);}emit(tail);if(pendingCR){pendingCR=false;emit('\n');}
    if(bytes!==size)throw Error('Source file changed while importing');if(!lastGood)throw Error('Book has no readable text');ftruncateSync(output,lastGood);fsyncSync(output);
  }finally{closeSync(input);closeSync(output);}
}
function* fileText(file:string,chunkBytes:number):Generator<string>{
 const fd=openSync(file,'r'),decoder=new TextDecoder('utf-8',{fatal:true});
 try{const buffer=Buffer.alloc(chunkBytes);let n;while((n=readSync(fd,buffer,0,buffer.length,null))){const text=decoder.decode(buffer.subarray(0,n),{stream:true});if(text)yield text;}const tail=decoder.decode();if(tail)yield tail;}finally{closeSync(fd);}
}
export function importFileBlob(dir:string,file:string,metadata:{filename:unknown;title:unknown;author?:unknown},chunkBytes=16*1024,progress?:(stage:string,done:number,total:number)=>void){
  if(!Number.isSafeInteger(chunkBytes)||chunkBytes<1||chunkBytes>256*1024)throw Error('Invalid import buffer size');
  // Reuse the authoritative metadata validation without loading the novel body.
  const identity=buildBook(metadata.filename,metadata.title,metadata.author,'x');
  const canonical=join(dir,randomUUID()+'.canonical.tmp');
  try{
    canonicalize(file,canonical,chunkBytes,(n,total)=>progress?.('normalize',n,total));
    progress?.('index',0,statSync(canonical).size);
    const sourceHash=createHash('sha256'),revision=createHash('sha256').update('1\n');let totalChars=0,indexBytes=0;const canonicalBytes=statSync(canonical).size;
    function* segments():Generator<Segment>{for(const segment of streamIndex(()=>fileText(canonical,chunkBytes))){sourceHash.update(segment.text);revision.update(segment.text);totalChars=segment.end;indexBytes+=Buffer.byteLength(segment.text);progress?.('index',indexBytes,canonicalBytes);yield segment;}}
    return writePagedStream(dir,()=>{const rev=revision.digest('hex');return {key:identity.id+':'+rev,id:identity.id,revision:rev,title:identity.title,author:identity.author,filename:identity.filename,sourceHash:sourceHash.digest('hex'),totalChars,parserVersion:1};},segments());
  }finally{if(existsSync(canonical))unlinkSync(canonical);}
}
