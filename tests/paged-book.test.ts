import { it, expect } from 'vitest';
import { buildBook } from '../src/books.ts';
import { streamIndex } from '../src/stream-index.ts';

it.each([
  '正文。'.repeat(3000),
  '# 第一章\n\n海风😀。\n第二行\n\n## 第二章\n后面',
  '第十二回 标题\n'+'𠮷😀海风'.repeat(3000)+'\n尾声',
  '  #   '+ ' '.repeat(5000)+'标题😀\n'+'正文'.repeat(4000),
  'a'.repeat(1201)+'\n第十二回 标题'+' '.repeat(5000)+'\n回家了。',
  '正文\n\n'+ '#'.repeat(7)+' 这不是标题\n最后',
  '# '+ '😀'.repeat(201)+'\n末尾',
  '正文\n\n    \n下一行',
])('rebuilds the same canonical index with bounded source chunks (%#)', text=>{
  const book=buildBook('a.txt','a','',text);
  function* chunks(){for(let at=0;at<book.text.length;){let end=Math.min(book.text.length,at+137);if(end<book.text.length&&/[\uD800-\uDBFF]/.test(book.text[end-1]))end--;yield book.text.slice(at,end);at=end;}}
  expect([...streamIndex(chunks)]).toEqual(book.segments);
});

import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PageCache, loadPagedBook, writePagedBook, chapterSpan } from '../src/paged-book.ts';
import { Library } from '../src/library.ts';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

it('keeps a shared bounded LRU across books, supports cold random ranges, and never caches the whole virtual array',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bookfish-pages-'));try{
    const cache=new PageCache(320*1024);
    const source=buildBook('a.txt','a','','海风😀。'.repeat(80000));
    const second=buildBook('b.txt','b','','第二本书。'.repeat(80000));
    const a=loadPagedBook(join(dir,writePagedBook(dir,source)+'.json.gz'),writePagedBook(dir,source),cache);
    const b=loadPagedBook(join(dir,writePagedBook(dir,second)+'.json.gz'),writePagedBook(dir,second),cache);
    expect(a.segments.length).toBe(source.segments.length);
    for(const index of [0,64,128,256,12,0]){expect(a.segments[index]).toEqual(source.segments[index]);expect(b.segments[index]).toEqual(second.segments[index]);expect(cache.bytes).toBeLessThanOrEqual(cache.limit);}
    expect(Object.keys(a.segments)).toEqual([]);expect(chapterSpan(a,100)?.last).toBe(source.segments.length-1);
    expect(()=>{a.segments[0]=source.segments[0];}).toThrow(/immutable/);
    cache.clear();expect(cache.bytes).toBe(0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
it('rejects a rehashed but noncanonical chapter index and altered page contents',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bookfish-pages-'));try{
    const source=buildBook('a.txt','a','','# 第一章\n'+'海风😀。'.repeat(3000));
    source.segments[1].chapter='伪造章节';const id=writePagedBook(dir,source);
    expect(()=>loadPagedBook(join(dir,id+'.json.gz'),id,new PageCache())).toThrow(/Canonical/);
    const file=join(dir,id+'.json.gz'),bytes=readFileSync(file);bytes[30]^=1;writeFileSync(file,bytes);
    expect(()=>loadPagedBook(file,id,new PageCache())).toThrow(/checksum/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
it('migrates the previous gzip format, preserves exact keys and progress, and keeps rollback data',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bookfish-old-pages-')),lib=new Library({dataDir:dir});try{
  lib.open();const imported=lib.importBytes({filename:'old.txt',title:'旧版'},Buffer.from('海风😀。'.repeat(10000)));lib.select(imported.book.key);const t=lib.readNext();lib.finish({...t,understanding:'合成存储验证'});
  const state=JSON.parse(JSON.parse(lib.export()).payload);lib.close();mkdirSync(join(lib.dir,'books'),{recursive:true});const book=state.books[0].book;const {text,...metadata}=book;const raw=Buffer.from(JSON.stringify({...metadata,$segmentsOnly:true}));const id=createHash('sha256').update(raw).digest('hex');writeFileSync(join(lib.dir,'books',id+'.json.gz'),gzipSync(raw));state.schema=4;state.books[0].book={$bookBlob:id};writeFileSync(lib.file,JSON.stringify(state));
  lib.open();expect(lib.status().current?.key).toBe(imported.book.key);expect(lib.status().current?.confirmedSegments).toBe(1);expect(lib.reread(imported.book.key,0).segment).toEqual(book.segments[0]);expect(JSON.parse(readFileSync(lib.file,'utf8')).schema).toBe(6);expect(statSync(lib.file+'.before-paged').size).toBeGreaterThan(0);expect(readdirSync(join(lib.dir,'books'))).toContain(id+'.json.gz');
 }finally{lib.close();rmSync(dir,{recursive:true,force:true});}
});
it('does not decode the rest of a book when listing and respects confirmed read boundaries',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bookfish-material-pages-')),lib=new Library({dataDir:dir});try{
  lib.open();const book=lib.importBytes({filename:'story.txt',title:'分页'},Buffer.from('海风😀。'.repeat(30000)));lib.select(book.book.key);
  const before=lib.storageStats().reads;for(let n=0;n<10;n++)lib.list();expect(lib.storageStats().reads).toBe(before);
  const t=lib.readNext();if(t.complete)throw Error('No task');expect(t.segment.text.length).toBeLessThanOrEqual(2400);lib.finish({...t,understanding:'合成测试'});
  expect(lib.reread(book.book.key,0).segment).toEqual(t.segment);expect(()=>lib.reread(book.book.key,1)).toThrow();
  expect(lib.search({query:'海风',kind:'text'}).items).toHaveLength(1);expect(lib.storageStats().bytes).toBeLessThanOrEqual(lib.storageStats().limit);
 }finally{lib.close();rmSync(dir,{recursive:true,force:true});}
});

import { fixture } from './fixtures/biquge.ts';
import { buildRemoteBook } from '../src/remote-books.ts';
import { digest } from '../src/books.ts';
import { SourceError } from '../src/source-types.ts';
it('pages remote chapter bodies and keeps status and source errors from loading the complete book',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bookfish-remote-pages-')),lib=new Library({dataDir:dir});try{
  const catalog=await fixture().catalog(),text='海风😀。'.repeat(5000),chapter={index:0,text,hash:digest(text),fetchedAt:new Date().toISOString(),pages:[{url:catalog.chapters[0].url,hash:'a'.repeat(64)}]};
  lib.open();const result=lib.importCatalog(catalog,lib.generation(),chapter);lib.select(result.book.key);const before=lib.storageStats().reads;for(let n=0;n<5;n++)lib.list();expect(lib.storageStats().reads).toBe(before);
  const task=lib.readNext();if(task.complete)throw Error('Missing source');lib.finish({...task,understanding:'存储合成验证'});lib.sourceFailed(result.book.key,lib.generation(),new SourceError('temporary','合成失败'));
  lib.close();lib.open();expect(lib.status().current?.source?.error?.message).toBe('合成失败');expect(lib.reread(result.book.key,0).segment).toEqual(task.segment);
  const empty=buildRemoteBook({catalog,cache:[]}),cache=new PageCache();const id=writePagedBook(join(lib.dir,'books'),empty);const loaded=loadPagedBook(join(lib.dir,'books',id+'.json.gz'),id,cache);expect(loaded.segments.length).toBe(0);
 }finally{lib.close();rmSync(dir,{recursive:true,force:true});}
});
it('matches the legacy parser for deterministic combinations of headings and whitespace',()=>{
 let seed=42;const pick=(n:number)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
 const lines=['正文。','😀'.repeat(800),'第十二回 回家','   第三章 海边   ','##    标题','####### 假标题',''.padEnd(250,' '),'#'+' '.repeat(1200)+'结尾','# '+ '😀'.repeat(110),'海风。'.repeat(500)];
 for(let n=0;n<120;n++){const text=Array.from({length:8},()=>lines[pick(lines.length)]).join('\n'.repeat(1+pick(3)));const source=buildBook('a.txt','a','',text);function* chunks(){for(const s of source.segments)yield s.text;}expect([...streamIndex(chunks)]).toEqual(source.segments);}
});

import { beginReview, reviewMaterials } from '../src/reviews.ts';
import type { LibraryState } from '../src/library.ts';
it('fetches only the requested page of full-book review materials',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bookfish-review-pages-'));try{
  const source=buildBook('a.txt','a','','海风😀。'.repeat(80000)),id=writePagedBook(dir,source),cache=new PageCache(1024*1024),book=loadPagedBook(join(dir,id+'.json.gz'),id,cache);
  const state:LibraryState={schema:3,generation:0,selected:book.key,paused:false,books:[{book,frontier:book.segments.length}],tasks:[],episodes:[],nextEpisodeSequence:1,reviewJobs:[],reviews:[],selection:{schema:1,generation:0,intents:[],queue:[],failures:[]}};
  const job=beginReview(state,{bookKey:book.key,requestId:'page-test'},1).job;
  cache.clear();const before=cache.reads;const page=reviewMaterials(state,{jobId:job.id,kind:'ranges',offset:0,limit:1},2);
  expect(page.items).toHaveLength(1);expect(page.total).toBe(book.segments.length);expect(cache.reads-before).toBe(1);expect(cache.bytes).toBeLessThanOrEqual(cache.limit);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
