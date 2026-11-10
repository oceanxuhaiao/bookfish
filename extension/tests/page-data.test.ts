import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { Sources } from '../src/sources.ts';
import { fixture, ROOT } from './fixtures/biquge.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { BOOKFISH } from '../src/definition.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { Discussions, discussionPauseMs } from '../src/discussions.ts';
let dir:string, lib:Library;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'bookfish-pages-'));lib=new Library({dataDir:dir,now:()=>1794105000000});lib.open();});
afterEach(()=>{lib.close();rmSync(dir,{recursive:true,force:true});});
it('records confirmation time, paginates only confirmed plots, and preserves times after reopening',()=>{
 const b=lib.import({filename:'a.txt',title:'a',base64:Buffer.from('海风。'.repeat(1500)).toString('base64')}).book;lib.select(b.key);
 for(let i=0;i<2;i++){const t=lib.readNext();lib.finish({...t,understanding:'这一段讲海边起风。'});}
 const first=lib.timeline(b.key,undefined,1);expect(first.items[0]).toMatchObject({segmentId:1,confirmedAt:1794105000000,startPage:3,endPage:4,summary:'这一段讲海边起风。'});expect(first.nextBefore).toBe(1);
 expect(lib.timeline(b.key,first.nextBefore!,1).items[0].segmentId).toBe(0);expect(lib.timeline(b.key).items).toHaveLength(2);
 lib.close();lib.open();expect(lib.timeline(b.key).items[0].confirmedAt).toBe(1794105000000);
});
it('does not invent timestamps for old receipts',()=>{
 const b=lib.import({filename:'a.txt',title:'a',base64:Buffer.from('海风。').toString('base64')}).book;lib.select(b.key);lib.finish({...lib.readNext(),understanding:'风起。'});const legacyPayload=JSON.parse(lib.export()).payload;lib.close();
 const path=join(lib.dir,'library.json'),state=JSON.parse(legacyPayload);delete state.tasks[0].receipt.confirmedAt;writeFileSync(path,JSON.stringify(state));lib.open();expect(lib.timeline().items[0].confirmedAt).toBeNull();
});
it('probes source text without importing, then requires a valid confirmation token',async()=>{
 const f=fixture(),sources=new Sources(lib,f.get);const probe=await sources.detect(ROOT);expect(lib.list()).toHaveLength(0);expect(()=>sources.accept('wrong')).toThrow();sources.accept(probe.token);expect(lib.list()).toHaveLength(1);expect(lib.list()[0].confirmedChars).toBe(0);expect(()=>sources.accept(probe.token)).toThrow();
});
it('failed source probes do not create a book',async()=>{
 const sources=new Sources(lib,async()=>{throw Error('offline');});await expect(sources.detect(ROOT)).rejects.toThrow();expect(lib.list()).toHaveLength(0);
});
it('bounds and expires panel replies without overwriting answers',()=>{
 const now=vi.spyOn(Date,'now').mockReturnValue(1000);try{const discussions=new Discussions();
 const request=discussions.create('book','episode','question');discussions.reply({discussionId:request.id,delivery:'spoken',segments:['answer']});expect(()=>discussions.reply({discussionId:request.id,delivery:'spoken',segments:['changed']})).toThrow();
 for(let i=1;i<20;i++)discussions.create('book','episode','question');expect(()=>discussions.create('book','episode','question')).toThrow(/full/);
 now.mockReturnValue(1801000);expect(()=>discussions.reply({discussionId:request.id,delivery:'spoken',segments:['answer']})).toThrow(/expired/);expect(discussions.list()[0].expired).toBe(true);discussions.removeBook('book');expect(discussions.list()).toHaveLength(0);
 }finally{now.mockRestore();}
});
it('requires short spoken discussion segments and keeps an unavailable delivery distinct',()=>{
 const discussions=new Discussions();
 const first=discussions.create('book','episode','question');
 expect(()=>discussions.reply({discussionId:first.id,delivery:'spoken',segments:['长'.repeat(61)]})).toThrow(/60/);
 expect(()=>discussions.reply({discussionId:first.id,delivery:'spoken',segments:[]})).toThrow(/segments/);
 expect(()=>discussions.reply({discussionId:first.id,delivery:'unavailable',segments:['我说了']})).toThrow(/must not/);
 const second=discussions.create('book','episode','question');
 expect(discussions.reply({discussionId:second.id,delivery:'unavailable',reason:'桌宠没有输出'})).toMatchObject({delivery:'unavailable',segments:[]});
 expect(discussions.list().find(item=>item.id===second.id)).toMatchObject({delivery:'unavailable',reason:'桌宠没有输出',segments:[]});
 const third=discussions.create('book','episode','question');
 expect(discussions.reply({discussionId:third.id,delivery:'spoken',segments:['【thinking】你好。','<wave>再见。']}).segments).toEqual(['你好。','再见。']);
 const fourth=discussions.create('book','episode','question');
 expect(discussions.reply({discussionId:fourth.id,delivery:'spoken',segments:['库...']}).segments).toEqual(['库...']);
 expect(discussionPauseMs(20)).toBe(6500);
 expect(discussionPauseMs(0)).toBeGreaterThanOrEqual(3000);
 expect(discussionPauseMs(200)).toBeLessThanOrEqual(12000);
});
it('discussion sends a bounded operator event linked to real evidence without advancing reading',async()=>{
 const context=fakeWorldContext(BOOKFISH,{scratchDir:join(dir,'world')});context.persist({automaticReading:false,realRoutineEnabled:false});const world=BOOKFISH.create(context),host=new FakeHost();await world.start(host);
 try{const invoke=world.webUi!().invoke!;const imported=await invoke('status','import',[{filename:'a.txt',title:'a',base64:Buffer.from('海风吹来。').toString('base64')}]) as {book:{key:string}};await invoke('status','select',[imported.book.key]);
 const tool=async(name:string,args:Record<string,unknown>)=>JSON.parse(await world.tools().find(t=>t.name===name)!.handler(args,{} as ToolCallContext) as string);
 const task=await tool('bookfish_read_next',{});const result=await tool('bookfish_finish_reading',{...task,understanding:'海边起风。',episode:{trigger:'起风',interpretation:'我喜欢这点风。',evidence:[{segmentId:0,quote:'海风吹来。'}]}});const before=await invoke('status','export',[]);
 const sent=await invoke('status','discuss',[{episodeId:result.receipt.episodeId,text:'接下来会下雨吗？'}]) as {discussionId:string};expect(host.events.at(-1)).toMatchObject({type:'bookfish.discussion',origin:'internal'});expect(host.events.at(-1)!.text).toContain(result.receipt.episodeId);expect(host.events.at(-1)!.text).toContain('pet_say');expect(host.events.at(-1)!.text).toContain('spoken');expect(await invoke('status','export',[])).toBe(before);
 const reply={discussionId:sent.discussionId,delivery:'spoken',segments:['我还没读到下雨。','只能猜，也许会。']};await tool('bookfish_discussion',{...reply,action:'reply'});await tool('bookfish_discussion',{...reply,action:'reply'});await expect(tool('bookfish_discussion',{...reply,action:'reply',segments:['changed']})).rejects.toThrow();
 const listed=await invoke('status','get',[]) as any;expect(listed.discussions[0]).toMatchObject({delivery:'spoken',segments:['我还没读到下雨。','只能猜，也许会。']});
 await expect(invoke('status','discuss',[{episodeId:'missing',text:'hello'}])).rejects.toThrow();
 }finally{await world.stop();}
});

it('timeline moods belong to the matching reading task and ignore later reflections',()=>{
 const b=lib.import({filename:'m.txt',title:'m',base64:Buffer.from('海风。'.repeat(900)).toString('base64')}).book;lib.select(b.key);
 const first=lib.readNext();const receipt=lib.finish({...first,understanding:'海边起风。',episode:{trigger:'风起',interpretation:'有些期待',mood:{label:'期待'},evidence:[{segmentId:0,quote:'海风。',start:0}]}});
 lib.finish({...lib.readNext(),understanding:'仍有海风。'});
 lib.reflect({bookKey:b.key,requestId:'later-mood',revises:receipt.receipt.episodeId,episode:{trigger:'回想',interpretation:'现在有些忧虑',mood:{label:'忧虑'},evidence:[{segmentId:0,quote:'海风。',start:0}]}});
 expect(lib.timeline().items[0].mood).toBeNull();expect(lib.timeline().items[1].mood?.label).toBe('期待');
});
