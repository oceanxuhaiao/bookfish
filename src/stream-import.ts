import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { openSync, closeSync, readSync, writeSync, ftruncateSync, fsyncSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildBook, MAX_BOOK_BYTES, type Segment } from './books.ts';
import { streamIndex } from './stream-index.ts';
import { writePagedStream } from './paged-book.ts';
const TEXT_ENCODING_ERROR = 'Book must use UTF-8, GB18030 or UTF-16 encoding';
const TEXT_ENCODING_DAMAGED = 'Book must use UTF-8, GB18030 or UTF-16 encoding; too many undecodable bytes (the file looks damaged or mixed-encoded)';
/** Pick an encoding from a bounded prefix without letting one stray byte flip the whole book. */
function detectEncoding(prefix: Buffer): string {
  if (prefix.length >= 3 && prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf) return 'utf-8';
  if (prefix.length >= 2 && prefix[0] === 0xff && prefix[1] === 0xfe) return 'utf-16le';
  if (prefix.length >= 2 && prefix[0] === 0xfe && prefix[1] === 0xff) return 'utf-16be';
  // GB18030 decodes almost any byte sequence, so "first decoder that does not throw"
  // would turn a UTF-8 novel with one damaged byte into mojibake. Prefer UTF-8 while its
  // damage stays inside the same small budget used for repair; otherwise let GB18030 win.
  const utf8Damage = countReplacement(new TextDecoder('utf-8', { fatal: false }).decode(prefix));
  if (utf8Damage <= Math.max(2, Math.floor(prefix.length * 0.002))) return 'utf-8';
  // GB18030 must decode clearly better than UTF-8, not merely "also succeed".
  const gbDamage = countReplacement(new TextDecoder('gb18030', { fatal: false }).decode(prefix));
  if (gbDamage * 10 < utf8Damage) return 'gb18030';
  throw Error(TEXT_ENCODING_ERROR);
}
/**
 * A single stray byte (e.g. one 0xA4 inside an otherwise valid UTF-8 novel) must not
 * condemn the whole book, but a truncated tail or a wall of garbage still must.
 * Isolated damage becomes U+FFFD and is counted; anything past this budget is refused.
 */
function repairBudget(chars: number) { return Math.max(16, Math.floor(chars * 0.0005)); }
function countReplacement(text: string) { let n = 0; for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 0xfffd) n += 1; return n; }
/** Decode/normalize on disk so even an all-whitespace tail or a newline-free book stays bounded. */
function canonicalize(source:string,target:string,chunkBytes:number,progress?:(done:number,total:number)=>void){
  const size=statSync(source).size;if(!size||size>MAX_BOOK_BYTES)throw Error('Book must be between 1 byte and 100 MiB');
  const input=openSync(source,'r');let output:number;
  try{output=openSync(target,'wx');}catch(error){closeSync(input);throw error;}
  let bytes=0,lastGood=0,offset=0,started=false,pendingCR=false,chars=0,repairs=0,lastChar='';
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
  // Count repaired characters and remember the last visible one, so a file that ends
  // mid-character (truncated) is still distinguishable from isolated damage.
  const take=(part:string)=>{chars+=part.length;for(let i=0;i<part.length;i++)if(part.charCodeAt(i)===0xfffd)repairs++;const trimmed=part.trimEnd();if(trimmed)lastChar=Array.from(trimmed).at(-1)??'';emit(part);};
  try{
    const headSize=Math.min(size,64*1024),head=Buffer.alloc(headSize);let n=readSync(input,head,0,headSize,null);
    if(!n)throw Error('Book has no readable text');
    const first=head.subarray(0,n);decoder=new TextDecoder(detectEncoding(first),{fatal:false});bytes=n;
    take(decoder.decode(first,{stream:true}));progress?.(bytes,size);
    const buffer=Buffer.alloc(chunkBytes);
    while((n=readSync(input,buffer,0,buffer.length,null))){bytes+=n;if(bytes>MAX_BOOK_BYTES)throw Error('Book exceeds 100 MiB');take(decoder.decode(buffer.subarray(0,n),{stream:true}));if(repairs>repairBudget(chars))throw Error(TEXT_ENCODING_DAMAGED);progress?.(bytes,size);}
    take(decoder.decode());if(pendingCR){pendingCR=false;take('\n');}
    if(repairs>0){if(lastChar==='\uFFFD')throw Error(TEXT_ENCODING_ERROR);if(repairs>repairBudget(chars))throw Error(TEXT_ENCODING_DAMAGED);}
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
