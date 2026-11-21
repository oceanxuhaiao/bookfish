import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, appendFileSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareFileBestEffort } from '../src/stream-import.ts';
import { decodeHtml } from '../src/txt-acquisition/html-encoding.ts';
import { assessText, TextQualityAccumulator } from '../src/txt-acquisition/quality.ts';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bf-r3-stream-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function prepare(bytes: Buffer, chunk = 1) { const file = join(dir, 'original.txt'); writeFileSync(file, bytes); const decoded = prepareFileBestEffort(file, chunk); return { text: readFileSync(decoded.canonicalFile!, 'utf8'), decoded }; }
describe('third-round decoding boundaries', () => {
  it('reports Chinese-number gaps without asserting whole-book completeness', () => {
    const result=assessText({text:'第九章\n她在海边等船。\n第十一章\n她终于看见白帆。',encoding:'utf-8',replacements:0,truncatedTail:false,repairs:[]});
    expect(result.report.warnings.map(w=>w.code)).toContain('chapters_missing');expect(result.verdict).toBe('accept');
  });
  it('matches independent character statistics for multilingual and supplementary text', () => {
    const text='汉字 abc\n\t　🌊𠀀é\ufffd\u0000!';const q=new TextQualityAccumulator();q.push(text);const m=q.finish();const points=[...text];expect(m.codePoints).toBe(points.length);expect(m.readableChars).toBe(points.filter(c=>!['\n','\r','\t',' ','　','\ufffd'].includes(c)).length);expect(m.supported).toBe(points.filter(c=>/[\p{L}\p{N}\p{P}\p{M}\p{Z}\p{S}\s]/u.test(c)||c==='\ufffd').length);
  });
  it.each(['utf8','gb18030','utf16le','utf16be'] as const)('preserves %s across the prefix and one-byte read boundaries', kind => {
    const prefix = 'a'.repeat(65535); const tail = '春晓🌊\r\n尾声'; const expected = prefix + tail.replace('\r\n','\n');
    let bytes: Buffer;
    if (kind === 'utf8') bytes = Buffer.from(prefix + tail);
    else if (kind === 'gb18030') bytes = Buffer.concat([Buffer.from(prefix),Buffer.from('b4bacffe','hex'),Buffer.from('\r\n'),Buffer.from('ceb2c9f9','hex')]);
    else { bytes = Buffer.concat([Buffer.from([255,254]),Buffer.from(prefix+tail,'utf16le')]); if (kind === 'utf16be') for (let i=0;i<bytes.length;i+=2) { const a=bytes[i];bytes[i]=bytes[i+1];bytes[i+1]=a; } }
    const result = prepare(bytes); expect(result.text).toBe(kind === 'gb18030' ? prefix+'春晓\n尾声' : expected); expect(result.decoded.metrics?.totalChars).toBe(result.text.length); expect(result.decoded.metrics?.codePoints).toBe([...result.text].length);
  });
  it('normalizes CRLF across a prefix boundary and EOF CR, trimming many whitespace blocks', () => {
    const prefix='a'.repeat(65535); expect(prepare(Buffer.from(prefix+'\r\n尾声\r')).text).toBe(prefix+'\n尾声');
    expect(prepare(Buffer.from(' '.repeat(65540)+'正文\n'+' '.repeat(70000)),1024).text).toBe('正文');
  });
  it('rejects all whitespace and removes prepared output while keeping original', () => {
    expect(()=>prepare(Buffer.from(' \r\n\t'.repeat(20000)))).toThrow(/no readable text/); expect(readdirSync(dir)).toEqual(['original.txt']);
  });
  it.each(['grow','shrink'] as const)('detects %s during reading and cleans temporary output', mode => {
    const file=join(dir,'original.txt');writeFileSync(file,Buffer.from('正文'.repeat(20000)));let changed=false;
    expect(()=>prepareFileBestEffort(file,1024,()=>{if(changed)return;changed=true;if(mode==='grow')appendFileSync(file,'新增');else truncateSync(file,65537);})).toThrow(/changed|grew/);expect(readdirSync(dir)).toEqual(['original.txt']);
  });
  it.each(['utf8','utf16le','utf16be'] as const)('BOM wins over conflicting HTTP and meta for HTML %s', kind => {
    const text='<meta charset="gbk"><title>春晓</title>';let bytes=kind==='utf8'?Buffer.concat([Buffer.from([239,187,191]),Buffer.from(text)]):Buffer.concat([Buffer.from([255,254]),Buffer.from(text,'utf16le')]);if(kind==='utf16be')for(let i=0;i<bytes.length;i+=2){const a=bytes[i];bytes[i]=bytes[i+1];bytes[i+1]=a;}
    expect(decodeHtml(bytes,'text/html; charset=gb2312').html).toBe(text);
  });
  it('HTTP beats meta, unsupported labels reject, complete meta at probe boundary is read', () => {
    const text='<META CHARSET=\'gbk\'><title>春晓</title>'; expect(decodeHtml(Buffer.from(text),'text/html; charset="UTF-8"').html).toBe(text);
    expect(()=>decodeHtml(Buffer.from(text),'text/html; charset=bad-encoding')).toThrow('Unsupported HTML charset');
    const prefix=' '.repeat(8192-20)+'<META charset="GBK">'; const bytes=Buffer.concat([Buffer.from(prefix),Buffer.from('b4bacffe','hex')]);expect(decodeHtml(bytes).html.endsWith('春晓')).toBe(true);
  });
});
