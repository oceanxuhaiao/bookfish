/** Public-domain sources only. Raw downloads and full bodies remain in ignored local scratch. */
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { fetchPinned } from '../src/txt-acquisition/pinned-http.ts';
const root=resolve('_verify/round3-real-sources');mkdirSync(root,{recursive:true});
const sources=[{id:'pride',title:'Pride and Prejudice',author:'Jane Austen',url:'https://ftp.gwdg.de/pub/misc/gutenberg/1/3/4/1342/1342.txt',provenance:'https://www.gutenberg.org/ebooks/1342',html:false},{id:'madman',title:'狂人日記',author:'魯迅',url:'https://zh.wikisource.org/wiki/%E7%8B%82%E4%BA%BA%E6%97%A5%E8%A8%98',provenance:'https://zh.wikisource.org/wiki/狂人日記',html:true}];
const results=[];
for(const source of sources){try{
 let raw:Buffer;
 if(process.argv.includes('--cached'))raw=readFileSync(join(root,source.id+'.raw'));
 else{const response=await fetchPinned(source.url,{allowNetwork:true,signal:AbortSignal.timeout(45000),headers:{'user-agent':'BookFish-round3-public-domain-validation','accept-encoding':'identity'}});
 if(!response.ok)throw Error('HTTP '+response.status);let size=0;const chunks:Buffer[]=[];const reader=response.body!.getReader();for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024){await reader.cancel();throw Error('Source too large');}chunks.push(Buffer.from(value));}
 raw=Buffer.concat(chunks);writeFileSync(join(root,source.id+'.raw'),raw);}
 let text=raw.toString('utf8');
 if(source.html){const $=load(text);const body=$('#mw-content-text .prp-pages-output').first();if(!body.length)throw Error('Transcribed work container missing');body.find('script,style,.mw-editsection,.navbox,.noprint,.ws-noexport,table').remove();text=body.text().replace(/\u200b/gu,'').trim();if(!text.startsWith('某君昆仲')||!text.includes('救救孩子')||!text.endsWith('（一九一八年四月。）'))throw Error('Expected novel opening or ending missing');}
 if(text.length<1000)throw Error('Insufficient actual text');const file=join(root,source.id+'.txt');writeFileSync(file,text);results.push({...source,acquired:true,rawBytes:raw.length,rawSha256:createHash('sha256').update(raw).digest('hex'),file,representation:source.html?'UTF-8 body extracted from actual HTML; not a native TXT download':'native UTF-8 TXT',bodySha256:createHash('sha256').update(text).digest('hex')});
 }catch(error){results.push({...source,acquired:false,error:String(error)});}}
writeFileSync(join(root,'sources.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
