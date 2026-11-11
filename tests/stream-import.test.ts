import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBook } from '../src/books.ts';
import { importFileBlob } from '../src/stream-import.ts';
import { PageCache, loadPagedBook } from '../src/paged-book.ts';
import { Library } from '../src/library.ts';
let dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'bookfish-stream-'));});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
it.each([1,2,3,7,16384])('matches legacy bytes, identity and exact indexes across %i-byte UTF-8/CRLF boundaries',chunk=>{
 const text='\uFEFF\uFEFF  \r\n# 标题😀\r\n'+('海风𠮷。'.repeat(400)+'\r').repeat(4)+'\r\n第十二回 回家  \r\n末尾😀。\u3000\t\r';
 const file=join(dir,'source.txt');writeFileSync(file,text);const expected=buildBook('book.txt',' 合成样本 ',' 作者 ',Buffer.from(text));
 const id=importFileBlob(dir,file,{filename:'book.txt',title:' 合成样本 ',author:' 作者 '},chunk);const actual=loadPagedBook(join(dir,id+'.json.gz'),id,new PageCache());
 expect(JSON.parse(JSON.stringify(actual))).toEqual(expected);expect(readdirSync(dir).filter(x=>x.endsWith('.tmp'))).toEqual([]);
});
it('never retains an arbitrarily long line or whitespace tail in the parser',()=>{
 const text='正文😀'.repeat(100000)+' '.repeat(300000),file=join(dir,'long.txt');writeFileSync(file,text);const expected=buildBook('book.txt','长行','',Buffer.from(text));
 const id=importFileBlob(dir,file,{filename:'book.txt',title:'长行'});const book=loadPagedBook(join(dir,id+'.json.gz'),id,new PageCache());expect(book.key).toBe(expected.key);expect(book.totalChars).toBe(expected.totalChars);expect(book.segments.at(-1)).toEqual(expected.segments.at(-1));
});
it.each([Buffer.from([0x61,0xff]),Buffer.from('海风\x00'),Buffer.from(' \r\n\t\uFEFF')])('rejects bad input without leaving canonical files or a partial book (%#)',bytes=>{
 const file=join(dir,'source.txt');writeFileSync(file,bytes);expect(()=>importFileBlob(dir,file,{filename:'a.txt',title:'a'},1)).toThrow();expect(readdirSync(dir)).toEqual(['source.txt']);
});
it('decodes a GB18030 local novel to UTF-8 before indexing',()=>{
 const bytes=Buffer.from([0xd6,0xd0,0xce,0xc4,0xb2,0xe2,0xca,0xd4,0xa1,0xa3]),file=join(dir,'gbk.txt');writeFileSync(file,bytes);
 const id=importFileBlob(dir,file,{filename:'gbk.txt',title:'GBK 样本'},1),book=loadPagedBook(join(dir,id+'.json.gz'),id,new PageCache());
 expect(book.segments.map(segment=>segment.text).join('')).toContain('中文测试。');
});
it('keeps old progress for a duplicate streaming import and leaves a failed commit unchanged',()=>{
 const file=join(dir,'source.txt'),text='海风😀。'.repeat(5000);writeFileSync(file,text);let fail=false;
 const lib=new Library({dataDir:dir,write:(file,state)=>{if(fail)throw Error('disk full');writeFileSync(file,JSON.stringify(state));}});
 try{lib.open();const first=lib.importFile({filename:'a.txt',title:'a'},file);lib.select(first.book.key);const task=lib.readNext();lib.finish({...task,understanding:'合成验证'});const duplicate=lib.importFile({filename:'a.txt',title:'a'},file);expect(duplicate.duplicate).toBe(true);expect(duplicate.book.confirmedSegments).toBe(1);
  const saved=readFileSync(lib.file);writeFileSync(file,'第二本书正文。'.repeat(5000));fail=true;expect(()=>lib.importFile({filename:'b.txt',title:'b'},file)).toThrow(/disk full/);expect(lib.list()).toHaveLength(1);expect(readFileSync(lib.file)).toEqual(saved);expect(readdirSync(join(lib.dir,'books')).filter(x=>x.endsWith('.tmp'))).toEqual([]);
 }finally{lib.close();}
});

it('cleans a late UTF-8 error after multiple input chunks and preserves the existing shelf',()=>{
 const file=join(dir,'source.txt'),lib=new Library({dataDir:dir});try{
  lib.open();const first=lib.importBytes({filename:'old.txt',title:'原书'},Buffer.from('原有正文。'));
  const before=readFileSync(lib.file);writeFileSync(file,Buffer.concat([Buffer.from('海风。'.repeat(10000)),Buffer.from([0xe4,0xb8])]));
  expect(()=>lib.importFile({filename:'bad.txt',title:'坏文件'},file)).toThrow(/UTF-8/);expect(lib.list().map(x=>x.key)).toEqual([first.book.key]);expect(readFileSync(lib.file)).toEqual(before);expect(readdirSync(join(lib.dir,'books'))).toHaveLength(0);
 }finally{lib.close();}
});

import { streamIndex } from '../src/stream-index.ts';
it('closes both repeatable readers when the segment consumer stops early',()=>{
 let opened=0,closed=0;function* chunks(){opened++;try{yield '海风😀。'.repeat(5000);}finally{closed++;}}
 const reader=streamIndex(chunks);expect(reader.next().done).toBe(false);reader.return(undefined);expect(opened).toBe(2);expect(closed).toBe(2);
});
