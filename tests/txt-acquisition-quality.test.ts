import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Library } from '../src/library.ts';
import { assessText } from '../src/txt-acquisition/quality.ts';
const dirs: string[]=[];afterEach(()=>{for(const path of dirs.splice(0))rmSync(path,{recursive:true,force:true});});
const fiction='她每天在码头点一盏灯。三十年后，船回来了，下来的人却问：这里有人等过我吗？';
function assess(text:string,replacements=0){return assessText({text,encoding:'utf-8',replacements,truncatedTail:false,repairs:[]});}
describe('prose tolerance across lengths and scripts',()=>{
 it('accepts complete microfiction below the old 200 character hard threshold',()=>{const result=assess(fiction);expect(result.verdict).toBe('accept');expect(result.report.warnings.map(issue=>issue.code)).toContain('short_text');});
 it.each([
  ['Arabic','عادت الفتاة إلى الميناء، وكانت تحمل رسالة قديمة. لم تجد السفينة، لكنها رأت الضوء في النافذة.'],
  ['Greek','Η κοπέλα επέστρεψε στο λιμάνι κρατώντας ένα παλιό γράμμα. Το φως στο παράθυρο ήταν ακόμη αναμμένο.'],
  ['Devanagari','वह पुराना पत्र लेकर बंदरगाह लौटी। नाव जा चुकी थी, लेकिन खिड़की में दीपक जल रहा था।'],
  ['Korean','그녀는 오래된 편지를 들고 항구로 돌아왔다. 배는 떠났지만 창문에는 아직 불이 켜져 있었다.'],
 ])('imports %s prose through the real loose library entry',(_name,text)=>{const dir=mkdtempSync(join(tmpdir(),'bookfish-script-'));dirs.push(dir);const library=new Library({dataDir:dir});library.open();try{const path=join(dir,'book.txt');writeFileSync(path,text.repeat(8));const result=library.importFileBestEffort({filename:'book.txt',title:'多语言短篇'},path);expect(result.imported).toBe(true);expect(library.reader({bookKey:result.book.key,segment:0}).segments[0]!.text).toContain(text);}finally{library.close();}});
 it('retains readable prose when replacement marks exceed ten percent',()=>{const text=fiction.repeat(10)+'\ufffd'.repeat(300);const result=assess(text,300);expect(result.verdict).toBe('accept');expect(result.report.quality).toBe('partial');expect(result.report.warnings.map(issue=>issue.code)).toContain('encoding_damaged');});
 it('does not reject fiction merely because characters talk about login and captcha',()=>{const result=assess('她说：“请先登录，输入验证码。”\n'+fiction.repeat(20));expect(result.verdict).toBe('accept');});
 it('still rejects a dominant login wall and text with no prose',()=>{expect(assess(('请先登录，输入验证码。\n').repeat(40)).verdict).toBe('reject');expect(assess('12345 !!! '+ '\ufffd'.repeat(100)).verdict).toBe('reject');});
});
