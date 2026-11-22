import {describe,it,expect,beforeEach,afterEach} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {bookSearchUrl,parseBookSearch} from '../src/txt-acquisition/book-search.ts';
import {TxtAcquisition,type PageLoader} from '../src/txt-acquisition/acquisition.ts';
import {BOOKFISH_DEFAULTS} from '../src/config.ts';import {Library} from '../src/library.ts';
const html='<ol><li class="b_algo"><h2><a href="https://books.example/sea">《海风》作者：小鱼 TXT</a></h2><div class="b_caption"><p>下载说明</p></div></li></ol>';
describe('browser book search',()=>{
  it('accepts title only or author only and bounds the query',()=>{
    expect(new URL(bookSearchUrl('','鲁迅')).searchParams.get('q')).toContain('鲁迅');expect(bookSearchUrl('狂人日记','')).toContain('bing.com');expect(()=>bookSearchUrl('','')).toThrow();expect(()=>bookSearchUrl('a'.repeat(201),'')).toThrow();
  });
  it('extracts bounded hints, unwraps Bing links, deduplicates and rejects unsafe link schemes',()=>{
    const wrapped='https://www.bing.com/ck/a?u=a1'+Buffer.from('https://books.example/sea').toString('base64url');
    const result=parseBookSearch(html+html.replace('https://books.example/sea',wrapped)+html.replace('https://books.example/sea','javascript:alert(1)'));
    expect(result.hits).toHaveLength(1);expect(result.hits[0]).toMatchObject({title:'《海风》作者：小鱼 TXT',suggestedTitle:'海风',host:'books.example'});expect(result.hits[0]).not.toHaveProperty('author');expect(result.blocked).toBe(false);
    expect(parseBookSearch('<div id="b_captcha">验证身份</div>')).toEqual({hits:[],blocked:true});
  });
  let dir:string,library:Library,acq:TxtAcquisition;let cfg={...BOOKFISH_DEFAULTS};let loader:PageLoader;
  beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),'bf-search-'));library=new Library({dataDir:dir});library.open();cfg={...BOOKFISH_DEFAULTS,allowNetwork:true,txtAcquisitionEnabled:true,browserProtectionMode:'standard',browserStandardConsent:true,browserDebugPort:9333};loader=async()=>({html,close:async()=>{}});acq=new TxtAcquisition({dataDir:dir,library,cfg:()=>cfg,resolve:async()=>['93.184.216.34'],pageLoader:(...args)=>loader(...args)});await acq.init();});
  afterEach(async()=>{await acq.stop();library.close();rmSync(dir,{recursive:true,force:true});});
  it('searches by author without creating acquisition tasks, books or progress',async()=>{
    expect((await acq.searchBooks({author:'小鱼'})).hits).toHaveLength(1);expect(acq.list()).toHaveLength(0);expect(library.list()).toHaveLength(0);expect(acq.summary().controllerReady).toBe(false);
  });
  it('refuses search without ordinary consent and aborts a pending search on revocation',async()=>{
    cfg.browserStandardConsent=false;await expect(acq.searchBooks({title:'海风'})).rejects.toThrow();cfg.browserStandardConsent=true;acq.onConfigChanged();
    let entered!:()=>void;const started=new Promise<void>(ok=>{entered=ok;});loader=async(_url,options)=>{entered();return await new Promise((_ok,no)=>options.signal!.addEventListener('abort',()=>no(Error('aborted')),{once:true}));};
    const pending=acq.searchBooks({author:'小鱼'});await started;cfg.browserStandardConsent=false;acq.onConfigChanged();await expect(pending).rejects.toThrow('中止');expect(acq.list()).toHaveLength(0);
  });
  it('offers a direct TXT as a candidate without downloading or substituting the wanted identity',async()=>{
    const task=await acq.discover({title:'Wanted',author:'Wanted author',pageUrl:'https://books.example/actual.txt'});expect(task.status).toBe('candidate_ready');expect(task.candidates?.[0].title).toBeUndefined();expect(library.list()).toHaveLength(0);
    const bad=await acq.discover({title:'private',pageUrl:'http://127.0.0.1/a.txt'});expect(bad.status).toMatch(/^failed_/);expect(bad.candidates).toHaveLength(0);
  });
});
