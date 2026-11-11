import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readingRoutine} from '../src/routine.ts';import {BOOKFISH_DEFAULTS,validateSettings} from '../src/config.ts';
import {Library} from '../src/library.ts';import {ReadingScheduler} from '../src/scheduler.ts';import {FakeHost} from './helpers/fake-host.ts';
const at=(s:string)=>Date.parse('2026-11-09T'+s+':00+08:00');
it('uses deployment time, combines sleep and breakfast, and uses exclusive end boundaries',()=>{
 expect(readingRoutine(BOOKFISH_DEFAULTS,at('23:00'),'Asia/Shanghai')).toMatchObject({kind:'sleep',until:'08:30'});
 expect(readingRoutine(BOOKFISH_DEFAULTS,at('08:00'),'Asia/Shanghai')).toMatchObject({kind:'breakfast',until:'08:30'});
 expect(readingRoutine(BOOKFISH_DEFAULTS,at('08:30'),'Asia/Shanghai')).toBeNull();expect(readingRoutine(BOOKFISH_DEFAULTS,at('12:00'),'Asia/Shanghai')?.kind).toBe('lunch');expect(readingRoutine(BOOKFISH_DEFAULTS,at('13:00'),'Asia/Shanghai')).toBeNull();
 expect(readingRoutine({...BOOKFISH_DEFAULTS,sleepStartMinute:0,sleepEndMinute:0},at('10:00'),'Asia/Shanghai')).toBeNull();
 expect(readingRoutine({...BOOKFISH_DEFAULTS,sleepEnabled:false,mealsEnabled:false},at('00:00'),'Asia/Shanghai')?.kind).toBe('sleep');
 expect(readingRoutine({...BOOKFISH_DEFAULTS,realRoutineEnabled:undefined},at('12:15'),'Asia/Shanghai')?.kind).toBe('lunch');
 expect(readingRoutine({...BOOKFISH_DEFAULTS,realRoutineEnabled:false},at('00:00'),'Asia/Shanghai')).toBeNull();
 expect(()=>validateSettings({lunchStartMinute:720})).toThrow(/Unsupported/);expect(()=>validateSettings({sleepEnabled:false})).toThrow(/Unsupported/);expect(validateSettings({realRoutineEnabled:false})).toEqual({realRoutineEnabled:false});
});
it('blocks auto offers, manual requests and direct reads while sleeping without changing confirmed progress',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bf-routine-'));let now=at('22:59');const lib=new Library({dataDir:dir,now:()=>now});lib.open();const book=lib.importBytes({filename:'x.txt',title:'作息样本'},Buffer.from('海边的小鱼。'.repeat(300)));lib.select(book.book.key);const cfg={...BOOKFISH_DEFAULTS,automaticReading:false};const s=new ReadingScheduler(lib,cfg,'Asia/Shanghai',()=>now);s.start(new FakeHost());
 try{const req=await s.requestNow(book.book.key),t=s.read(req.opportunityId);if(t.complete)throw Error('Expected text');now=at('23:00');expect(()=>s.finish({...t,opportunityId:req.opportunityId,understanding:'测试'})).toThrow(/睡觉/);expect(lib.status().current!.confirmedChars).toBe(0);expect(lib.status().pending).toBeNull();await expect(s.requestNow(book.book.key)).rejects.toThrow(/睡觉/);expect(()=>s.read(undefined)).toThrow(/睡觉/);cfg.automaticReading=true;await s.tick();expect(s.status().reason).toBe('routine');expect(s.status().active).toBeNull();
 now=at('08:15');await expect(s.requestNow(book.book.key)).rejects.toThrow(/早餐/);now=at('08:30');expect((await s.requestNow(book.book.key)).accepted).toBe(true);
 }finally{s.stop();lib.close();rmSync(dir,{recursive:true,force:true});}
});

it('turns sleep and all meals off together while keeping normal reading available',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bf-real-routine-'));let now=at('00:00');const lib=new Library({dataDir:dir,now:()=>now});lib.open();const book=lib.importBytes({filename:'x.txt',title:'关闭真实作息'},Buffer.from('海风。'.repeat(900)));lib.select(book.book.key);const cfg={...BOOKFISH_DEFAULTS,automaticReading:false,realRoutineEnabled:false};const s=new ReadingScheduler(lib,cfg,'Asia/Shanghai',()=>now);s.start(new FakeHost());
 try{expect(s.status().routine).toBeNull();const req=await s.requestNow(book.book.key);const t=s.read(req.opportunityId);expect(t.complete).toBe(false);now=at('12:15');expect(s.status().routine).toBeNull();cfg.realRoutineEnabled=true;await expect(s.requestNow(book.book.key)).rejects.toThrow(/午餐/);expect(lib.status().current!.confirmedChars).toBe(0);}finally{s.stop();lib.close();rmSync(dir,{recursive:true,force:true});}
});
