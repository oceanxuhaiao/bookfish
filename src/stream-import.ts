import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { openSync, closeSync, readSync, writeSync, ftruncateSync, fsyncSync, statSync, unlinkSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBook, MAX_BOOK_BYTES, type Segment } from './books.ts';
import { streamIndex } from './stream-index.ts';
import { writePagedStream } from './paged-book.ts';
import { decodeBestEffort, detectEncoding as detectEncodingLoosely, looksBinary, normalizeText } from './txt-acquisition/repair.ts';
import type { DetectedEncoding, QualityIssue } from './txt-acquisition/types.ts';
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

/**
 * Loose import entry point. The strict path above keeps refusing damaged files;
 * this one is only reached from the acquisition flow, which already holds the
 * original bytes and a quality report. It decodes leniently (BOM/GB18030/
 * UTF-16, stray bad bytes, incomplete tail) and never rejects a file merely for
 * imperfect chapters or suspected truncation.
 */
export class BestEffortRejected extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BestEffortRejected';
  }
}

export interface BestEffortDecoded {
  text: string;
  encoding: DetectedEncoding;
  repairs: QualityIssue[];
  replacements: number;
  truncatedTail: boolean;
  bytes: number;
}

/** Read the staged file, detect the encoding from content, decode and normalize. */
export function decodeFileBestEffort(file: string, chunkBytes = 16 * 1024, progress?: (done: number, total: number) => void): BestEffortDecoded {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 256 * 1024) throw Error('Invalid import buffer size');
  const size = statSync(file).size;
  if (!size) throw new BestEffortRejected('empty_file', 'The downloaded file is empty');
  if (size > MAX_BOOK_BYTES) throw new BestEffortRejected('too_large', 'The downloaded file exceeds 100 MiB');
  const chunks: Buffer[] = [];
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(chunkBytes, size));
    let read = 0;
    let n: number;
    while ((n = readSync(fd, buffer, 0, buffer.length, null))) {
      chunks.push(Buffer.from(buffer.subarray(0, n)));
      read += n;
      progress?.(read, size);
    }
  } finally {
    closeSync(fd);
  }
  const bytes = Buffer.concat(chunks, size);
  if (looksBinary(bytes)) throw new BestEffortRejected('binary_file', 'The downloaded file looks binary, not text');
  const encoding = detectEncodingLoosely(bytes);
  const decoded = decodeBestEffort(bytes, encoding);
  const normalized = normalizeText(decoded.text);
  const text = normalized.text;
  if (!text.trim()) throw new BestEffortRejected('empty_file', 'The downloaded file has no readable text');
  return {
    text,
    encoding,
    repairs: [...decoded.issues, ...normalized.issues],
    replacements: decoded.replacements,
    truncatedTail: normalized.truncatedTail,
    bytes: size,
  };
}

/** Build the paged book from already-decoded text; shares the strict segmenter. */
export function importFileBlobBestEffort(
  dir: string,
  file: string,
  metadata: { filename: unknown; title: unknown; author?: unknown },
  chunkBytes = 16 * 1024,
  progress?: (stage: string, done: number, total: number) => void,
  decoded?: BestEffortDecoded,
): { id: string; decoded: BestEffortDecoded } {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 256 * 1024) throw Error('Invalid import buffer size');
  const identity = buildBook(metadata.filename, metadata.title, metadata.author, 'x');
  const prepared = decoded ?? decodeFileBestEffort(file, chunkBytes, (n, total) => progress?.('normalize', n, total));
  const canonical = join(dir, randomUUID() + '.canonical.tmp');
  try {
    writeFileSync(canonical, prepared.text, 'utf8');
    progress?.('index', 0, statSync(canonical).size);
    const sourceHash = createHash('sha256');
    const revision = createHash('sha256').update('1\n');
    let totalChars = 0;
    let indexBytes = 0;
    const canonicalBytes = statSync(canonical).size;
    function* segments(): Generator<Segment> {
      for (const segment of streamIndex(() => fileText(canonical, chunkBytes))) {
        sourceHash.update(segment.text);
        revision.update(segment.text);
        totalChars = segment.end;
        indexBytes += Buffer.byteLength(segment.text);
        progress?.('index', indexBytes, canonicalBytes);
        yield segment;
      }
    }
    const id = writePagedStream(dir, () => {
      const rev = revision.digest('hex');
      return { key: identity.id + ':' + rev, id: identity.id, revision: rev, title: identity.title, author: identity.author, filename: identity.filename, sourceHash: sourceHash.digest('hex'), totalChars, parserVersion: 1 };
    }, segments());
    return { id, decoded: prepared };
  } finally {
    if (existsSync(canonical)) unlinkSync(canonical);
  }
}

