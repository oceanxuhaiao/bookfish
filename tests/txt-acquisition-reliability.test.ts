import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { BOOKFISH_DEFAULTS } from '../src/config.ts';
import { TxtAcquisition } from '../src/txt-acquisition/acquisition.ts';
import { decodeHtml } from '../src/txt-acquisition/html-encoding.ts';
import { discoverLinks } from '../src/txt-acquisition/link-discovery.ts';
import { decodeFileBestEffort, prepareFileBestEffort } from '../src/stream-import.ts';
import { AcquisitionRecords } from '../src/txt-acquisition/records.ts';
import { BrowserBridge } from '../src/txt-acquisition/bridge.ts';
import { TextQualityAccumulator, assessText } from '../src/txt-acquisition/quality.ts';
const prose = '她把信折好放进抽屉，海风从窗口吹进来。';
const gb = Buffer.from('cbfdb0d1d0c5d5dbbac3b7c5bdf8b3e9cceba3acbaa3b7e7b4d3b4b0bfdab4b5bdf8c0b4a1a3', 'hex');
let dir: string; let library: Library;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bf-reliability-')); library = new Library({ dataDir: dir }); library.open(); });
afterEach(() => { vi.restoreAllMocks(); library.close(); rmSync(dir, { recursive: true, force: true }); });
function acquisition(bytes = Buffer.from(prose.repeat(80)), callback?: () => void | Promise<void>) { return new TxtAcquisition({ dataDir: dir, library, cfg: () => ({ ...BOOKFISH_DEFAULTS, txtAcquisitionEnabled: true, autonomousAcquisition: !!callback }), resolve: async () => ['93.184.216.34'], fetchImpl: (async () => new Response(bytes)) as typeof fetch, onImported: callback }); }
function raw(acq: TxtAcquisition) { return readdirSync(acq.staging.rawDir).filter(f => !f.includes('prepared')); }
describe('second-round reliability regressions', () => {
  it.each(['retry', 'repair'] as const)('recovers a retained post-download import failure through %s without changing old progress', async action => {
    const old = library.importFileBestEffort; const spy = vi.spyOn(library, 'importFileBestEffort').mockImplementationOnce(() => { throw new Error('temporary disk error'); });
    const acq = acquisition(); const quota = vi.spyOn(acq.staging, 'enforceQuota'); await acq.init(); const failed = await acq.importFile({ url: 'https://books.example/book.txt', title: '海风' });
    expect(quota).toHaveBeenCalledTimes(2); expect(failed.status).toBe('failed_recoverable'); expect(failed.failure?.code).toBe('import_failed'); expect(raw(acq)).toHaveLength(1); const original = readFileSync(join(acq.staging.rawDir, raw(acq)[0]!));
    spy.mockRestore(); const keep = join(dir, 'older.txt'); writeFileSync(keep, prose.repeat(30)); const older = old.call(library, { filename: 'older.txt', title: '旧书' }, keep); library.select(older.book.key); const reading = library.readNext(); if(reading.complete) throw Error('Expected unread old book'); library.finish({taskId:reading.taskId,bookKey:reading.bookKey,segmentId:reading.segmentId,understanding:'她在窗口等船。'}); const before = library.list().find(b => b.key === older.book.key); expect(before!.confirmedChars).toBeGreaterThan(0);
    const done = action === 'retry' ? await acq.retry(failed.taskId) : await acq.repair(failed.taskId);
    expect(done.status).toMatch(/^completed/); expect(done.file?.sha256).toBe(failed.file?.sha256); expect(library.list().find(b => b.key === older.book.key)).toEqual(before); expect(original.equals(Buffer.from(prose.repeat(80)))).toBe(true);
  });
  it('keeps committed shelf success separate from an async queue callback failure', async () => {
    const acq = acquisition(undefined, async () => { throw Error('queue unavailable https://secret.example/token?signed=private'); }); await acq.init();
    const done = await acq.importFile({ url: 'https://books.example/book.txt', title: '海风', origin: 'autonomous', intentId: 'callback-test' }); expect(done.status).toMatch(/^completed/); expect(done.failure).toBeUndefined(); expect(done.selection?.status).toBe('failed'); expect(done.selection?.message).not.toContain('private'); expect(library.list().some(b => b.key === done.bookKey)).toBe(true);
  });
  it('automatically prunes after init and completion but protects warning originals', async () => {
    const acq = acquisition(); await acq.staging.init(); const orphan = join(acq.staging.rawDir, 'a'.repeat(64)+'.txt'); writeFileSync(orphan, Buffer.alloc(1024));
    const spy = vi.spyOn(acq.staging, 'enforceQuota'); await acq.init(); expect(spy).toHaveBeenCalledOnce();
    const done = await acq.importFile({ url: 'https://books.example/book.txt', title: '海风' }); expect(done.file?.retained).toBe(true); expect(spy).toHaveBeenCalledTimes(2); expect(raw(acq).length).toBeGreaterThanOrEqual(1); expect(existsSync(join(acq.staging.rawDir, raw(acq).find(f => f.startsWith(done.file!.sha256))!))).toBe(true);
    expect(JSON.parse(readFileSync(join(acq.root, 'quota.json'),'utf8')).reason).toBeNull();
  });
  it('does not trim the only retained-original references when the task cap is exceeded', async () => {
    const acq = acquisition(); await acq.init(); const done = await acq.importFile({ url: 'https://books.example/book.txt', title: '海风' }); const task = acq.records.get(done.taskId)!;
    for(let i=0;i<105;i++) acq.records.put({ ...structuredClone(task), id: randomUUID(), updatedAt:i });
    expect(acq.records.list()).toHaveLength(106); expect(acq.records.list().every(t=>t.file?.retained)).toBe(true);
    const restored = new AcquisitionRecords(acq.root); restored.load(); expect(restored.list()).toHaveLength(106);
  });
  it('keeps a protected original loadable when active candidate tasks reach the cap', async () => {
    const acq = acquisition(); await acq.init(); const done = await acq.importFile({url:'https://books.example/book.txt',title:'海风'}); const template=acq.records.get(done.taskId)!;
    for(let i=0;i<100;i++)acq.records.put({...structuredClone(template),id:randomUUID(),status:'candidate_ready',file:undefined,updatedAt:i});
    await expect(acq.discover({pageUrl:'https://books.example/page',title:'another'})).rejects.toThrow(/Finish or cancel/);
    const restored=new AcquisitionRecords(acq.root);restored.load();expect(restored.list()).toHaveLength(101);expect(restored.get(done.taskId)?.file?.retained).toBe(true);
  });
  it('does not advertise a merely running transport as a ready protected browser', async () => {
    const bridge=new BrowserBridge({dataDir:join(dir,'readiness-bridge'),port:0});
    const acq = new TxtAcquisition({ dataDir:dir, library, bridge, cfg:()=>({...BOOKFISH_DEFAULTS,txtAcquisitionEnabled:true,browserBridgeEnabled:true}), browserGuard:async()=>undefined }); await acq.init();
    try { expect(acq.bridgeInfo.running).toBe(true); expect(acq.summary()).toMatchObject({ transportConnected:false,controllerReady:false,browserReady:false,browserConfigured:false }); } finally { await acq.stop(); }
  });
  it.each(['utf8-first','gb-first','utf8-damage','gb','utf16'] as const)('preserves the confidently decoded opening when processing %s', kind => {
    const utf = Buffer.from(prose.repeat(300)); const gbBody = Buffer.concat(Array.from({length:300},()=>gb));
    const bytes = kind==='utf8-first'?Buffer.concat([utf,gbBody]):kind==='gb-first'?Buffer.concat([gbBody,utf]):kind==='utf8-damage'?Buffer.concat([utf.subarray(0,500),Buffer.from([255]),utf.subarray(500)]):kind==='gb'?gbBody:Buffer.concat([Buffer.from([255,254]),Buffer.from(prose.repeat(300),'utf16le')]);
    const file = join(dir,kind+'.txt'); writeFileSync(file,bytes); const baseline=decodeFileBestEffort(file); const prepared=prepareFileBestEffort(file,7); const text=readFileSync(prepared.canonicalFile!,'utf8');
    expect(text).toBe(baseline.text); expect(text.startsWith(prose)).toBe(true); expect(readFileSync(file)).toEqual(bytes); expect(prepared.metrics?.totalChars).toBe(text.length); rmSync(prepared.canonicalFile!);
  });
  it('does not let the UTF-8 damage allowance misclassify a tiny valid GBK text', () => {
    const file=join(dir,'tiny-gbk.txt');writeFileSync(file,Buffer.from('b4bacffe','hex'));const prepared=prepareFileBestEffort(file);expect(prepared.encoding).toBe('gb18030');expect(readFileSync(prepared.canonicalFile!,'utf8')).toBe('春晓');
  });
  it('keeps streaming normalization and quality equivalent across tiny chunk boundaries', () => {
    const text='  第1章\r\n'+prose+'\n\n\n\n\n第3章\n'+prose+'\u0001\n\n'; const file=join(dir,'chunks.txt'); writeFileSync(file,text);const baseline=decodeFileBestEffort(file);const prepared=prepareFileBestEffort(file,1);
    expect(readFileSync(prepared.canonicalFile!,'utf8')).toBe(baseline.text);
    const first=assessText({...baseline}); const second=assessText({...prepared});expect(second.report).toMatchObject({ readableChars:first.report.readableChars,totalChars:first.report.totalChars,quality:first.report.quality });expect(second.report.warnings.map(w=>w.code)).toEqual(first.report.warnings.map(w=>w.code));
  });
  it.each(['header','meta','fallback','bom'] as const)('decodes Chinese HTML via %s without changing relative links or author', kind => {
    const prefix=Buffer.from('<html><head>'+(kind==='meta'?'<meta charset="gbk">':'')+'<title>');const suffix=Buffer.from('</title></head><body><a href="../dl/book.txt">');
    const name = kind==='bom'?Buffer.from(prose):gb;
    const bytes=Buffer.concat([kind==='bom'?Buffer.from([239,187,191]):Buffer.alloc(0),prefix,name,suffix,kind==='bom'?Buffer.from('《海风》 作者：小鱼</a></body></html>'):Buffer.concat([Buffer.from('a1b6baa3b7e7a1b720d7f7d5dfa3bad0a1d3e3','hex'),Buffer.from('</a></body></html>')])]);
    const decoded=decodeHtml(bytes,kind==='header'?'text/html; charset=GBK':'text/html'); const found=discoverLinks(decoded.html,'https://books.example/page/index.html');expect(found.pageTitle).toBe(prose);expect(found.links[0]?.url).toBe('https://books.example/dl/book.txt'); expect(found.links[0]?.author).toBe('小鱼'); expect(found.links[0]?.title).toBe('海风');
  });
});
