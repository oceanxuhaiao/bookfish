/** Public-domain novel plus explicitly labelled derived tolerance fixtures. No model calls. */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { Library } from '../src/library.ts';
import { decodeFileBestEffort } from '../src/stream-import.ts';
import { fetchPinned } from '../src/txt-acquisition/pinned-http.ts';
const root=resolve('_verify/quality-matrix');mkdirSync(root,{recursive:true});
const synthetic=process.argv.includes('--synthetic');
const source=join(root,synthetic?'synthetic-source.txt':'alice-source.txt');
if(synthetic)writeFileSync(source,Buffer.from('她把信折好放进抽屉，海风从窗口吹进来，桌上的灯忽明忽暗。\n'.repeat(600)));
if(!existsSync(source)){const response=await fetchPinned('https://www.gutenberg.org/cache/epub/11/pg11.txt',{allowNetwork:true,signal:AbortSignal.timeout(20000),resolve:async host=>(await lookup(host,{all:true,verbatim:true})).sort((a,b)=>a.family-b.family).map(a=>a.address)});if(!response.ok)throw new Error('Source HTTP '+response.status);const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>2*1024*1024)throw new Error('Source too large');writeFileSync(source,bytes);}
const original=readFileSync(source);const base=original.toString('utf8');const sample=base.slice(5000,15000);const chn='她把信折好放进抽屉，海风从窗口吹进来，桌上的灯忽明忽暗。';
const samples:Array<{id:string;kind:string;bytes:Buffer;reject?:boolean}>=[
 {id:'utf8-public-novel',kind:synthetic?'synthetic original prose':'real public-domain novel',bytes:original},
 {id:'gbk',kind:'synthetic GBK Chinese prose',bytes:Buffer.concat(Array.from({length:200},()=>Buffer.from([0xd6,0xd0,0xce,0xc4,0xb2,0xe2,0xca,0xd4,0xa1,0xa3])))},
 {id:'minor-damage',kind:'derived source prose',bytes:Buffer.concat([Buffer.from(sample.slice(0,1000)),Buffer.from([255]),Buffer.from(sample.slice(1000))])},
 {id:'mixed-encoding',kind:'derived public novel plus GBK text',bytes:Buffer.concat([Buffer.from(sample),Buffer.from([0xd6,0xd0,0xce,0xc4,0xa1,0xa3])])},
 {id:'ads',kind:'derived public novel',bytes:Buffer.from(sample+'\n请记住本站 www.example.com 最新章节免费阅读\n'+sample)},
 {id:'missing-chapters',kind:'derived public novel',bytes:Buffer.from('第1章\n'+sample+'\n第3章\n'+sample)},
 {id:'irregular-chapters',kind:'derived public novel',bytes:Buffer.from('第2章\n'+sample+'\n第1章\n'+sample)},
 {id:'truncated-tail',kind:'derived public novel',bytes:Buffer.concat([Buffer.from(sample),Buffer.from([0xe4])])},
 {id:'readable-partial',kind:'derived public novel',bytes:Buffer.from(sample.slice(0,2500))},
 {id:'microfiction',kind:'synthetic original short prose',bytes:Buffer.from('她每天在码头点一盏灯。三十年后，船回来了，下来的人却问：这里有人等过我吗？')},
 {id:'non-ascii',kind:'synthetic multilingual prose',bytes:Buffer.from(('عادت الفتاة إلى الميناء. Η κοπέλα επέστρεψε στο λιμάνι. वह पुराना पत्र लेकर लौटी।\n').repeat(20))},
 {id:'strict-rejected-control',kind:'derived public novel; strict rejection reproduced here',bytes:Buffer.from(sample+'\u0001')},
 {id:'empty',kind:'negative control',bytes:Buffer.alloc(0),reject:true},
 {id:'binary',kind:'negative control',bytes:Buffer.alloc(4096),reject:true},
 {id:'gate',kind:'negative control',bytes:Buffer.from(('请先登录，输入验证码后继续。\n').repeat(40)),reject:true},
 {id:'no-prose',kind:'negative control',bytes:Buffer.from(('123456789 !!!\n').repeat(100)),reject:true},
];
const library=new Library({dataDir:join(root,'shelf')});library.open();const results=[];
try{for(const item of samples){const file=join(root,item.id+'.txt');writeFileSync(file,item.bytes);const hash=createHash('sha256').update(item.bytes).digest('hex');let strictRejected:boolean|undefined;if(item.id==='strict-rejected-control'){try{library.importFile({filename:item.id+'.txt',title:item.id+' strict'},file);strictRejected=false;}catch{strictRejected=true;}}
 try{const decoded=decodeFileBestEffort(file);const imported=library.importFileBestEffort({filename:item.id+'.txt',title:item.id},file,{decoded});const reader=library.reader({bookKey:imported.book.key,segment:0});results.push({id:item.id,kind:item.kind,bytes:item.bytes.length,sha256:hash,encoding:decoded.encoding,readableChars:imported.quality.readableChars,replacements:decoded.replacements,replacementRatio:decoded.replacements/Math.max(1,decoded.text.length),repairs:decoded.repairs,quality:imported.quality.quality,warnings:imported.quality.warnings.map(issue=>issue.code),imported:true,readableSegment:reader.segments[0]?.text.length??0,confirmedChars:library.list().find(book=>book.key===imported.book.key)?.confirmedChars??0,originalUnchanged:createHash('sha256').update(readFileSync(file)).digest('hex')===hash,strictRejected,expectationMet:!item.reject});}
 catch(error){results.push({id:item.id,kind:item.kind,bytes:item.bytes.length,sha256:hash,imported:false,error:(error as Error).message,expectationMet:item.reject===true});}
 }}finally{library.close();}
const report={source:{url:synthetic?null:'https://www.gutenberg.org/cache/epub/11/pg11.txt',synthetic,sha256:createHash('sha256').update(original).digest('hex'),bytes:original.length},realNovelCount:synthetic?0:1,derivedOrSyntheticCount:synthetic?12:11,negativeControls:4,humanReadingReview:false,results};writeFileSync(join(root,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(results.some(item=>!item.expectationMet))process.exitCode=1;
