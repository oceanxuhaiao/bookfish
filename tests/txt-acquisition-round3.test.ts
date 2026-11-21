import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { BOOKFISH_DEFAULTS } from '../src/config.ts';
import { TxtAcquisition } from '../src/txt-acquisition/acquisition.ts';
import { AcquisitionStaging } from '../src/txt-acquisition/staging.ts';
import * as disk from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));
let dir: string, library: Library;
const prose = '她把信折好放进抽屉，海风从窗口吹进来。'.repeat(80);
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bf-r3-')); library = new Library({ dataDir: dir }); library.open(); });
afterEach(() => { vi.restoreAllMocks(); library.close(); rmSync(dir, { recursive: true, force: true }); });
function acquisition(onImported?: () => void | Promise<void>) { return new TxtAcquisition({ dataDir: dir, library, cfg: () => ({ ...BOOKFISH_DEFAULTS, txtAcquisitionEnabled: true }), resolve: async () => ['93.184.216.34'], fetchImpl: (async () => new Response(prose)) as typeof fetch, onImported }); }
async function failedOriginal() {
  const acq = acquisition(); await acq.init(); const spy = vi.spyOn(library, 'importFileBestEffort').mockImplementationOnce(() => { throw Error('disk temporarily unavailable'); });
  const failed = await acq.importFile({ url: 'https://books.example/a.txt', title: '海风' }); spy.mockRestore();
  expect(failed.status).toBe('failed_recoverable'); const task = acq.records.get(failed.taskId)!; return { acq, failed, path: acq.staging.resolveInside(task.file!.path!) };
}
describe('third-round original integrity', () => {
  it('finishes a pending raw commit on retry without requiring a World restart', async () => {
    const acq=acquisition();await acq.init();const fault=vi.spyOn(acq.staging,'commitRaw').mockRejectedValueOnce(Object.assign(Error('busy'),{code:'EBUSY'}));
    const failed=await acq.importFile({url:'https://books.example/a.txt',title:'海风'});fault.mockRestore();const done=await acq.retry(failed.taskId);expect(done.status).toMatch(/^completed/);expect((await acq.retry(done.taskId)).bookKey).toBe(done.bookKey);expect(acq.records.get(done.taskId)?.attempts.downloads).toBe(1);expect(library.list()).toHaveLength(1);
  });
  it('shares raw bytes safely across simultaneous tasks and duplicate shelf imports', async () => {
    const acq=acquisition();await acq.init();const results=await Promise.all([1,2,3].map(()=>acq.importFile({url:'https://books.example/a.txt',title:'海风'})));
    expect(new Set(results.map(r=>r.taskId)).size).toBe(3);expect(new Set(results.map(r=>r.file?.sha256)).size).toBe(1);expect(library.list()).toHaveLength(1);expect(library.list()[0].confirmedChars).toBe(0);
    const first=acq.records.get(results[0].taskId)!;acq.records.update(first.id,t=>{t.file!.retained=false;});await (acq as any).dropRaw(first.file!.path);expect(readFileSync(acq.staging.resolveInside(acq.records.get(results[1].taskId)!.file!.path!),'utf8')).toBe(prose);
  });
  it('refuses a new task if its initial durable record cannot be written', async () => {
    const acq=acquisition();await acq.init();mkdirSync(acq.records.file+'.'+process.pid+'.tmp');
    await expect(acq.importFile({url:'https://books.example/a.txt',title:'not created'})).rejects.toThrow();expect(acq.records.list()).toHaveLength(0);expect(library.list()).toHaveLength(0);
  });
  it('does not let a retained retry consume a 101st active slot', async () => {
    const {acq,failed}=await failedOriginal();const template=acq.records.get(failed.taskId)!;
    for(let i=0;i<100;i++)acq.records.put({...template,id:randomUUID(),status:'candidate_ready',file:undefined});
    const result=await acq.retry(failed.taskId);expect(result.status).toBe('failed_recoverable');expect(acq.records.list().filter(t=>t.status==='candidate_ready')).toHaveLength(100);expect(library.list()).toHaveLength(0);
  });
  it('reports read permission failure as storage, preserving the original digest', async () => {
    const {acq,failed}=await failedOriginal();vi.spyOn(disk,'open').mockRejectedValueOnce(Object.assign(Error('denied'),{code:'EACCES'}));
    const result=await acq.retry(failed.taskId);expect(result.failure?.code).toBe('storage_unavailable');expect(result.file?.sha256).toBe(failed.file?.sha256);expect(library.list()).toHaveLength(0);
  });
  it('rejects a symlink identity before opening its target (filesystem fault fixture)', async () => {
    const {acq,failed}=await failedOriginal();const original=disk.lstat;vi.spyOn(disk,'lstat').mockImplementation(async (...args)=>{const value=await original(...args);if(String(args[0]).includes('.txt'))value.isSymbolicLink=()=>true;return value;});
    const result=await acq.retry(failed.taskId);expect(result.failure?.code).toBe('original_integrity');expect(library.list()).toHaveLength(0);
  });
  it('does not mark completion or queue when cancelled just before shelf metadata commits', async () => {
    library.close(); let armed = false; let acq: TxtAcquisition;
    library = new Library({dataDir:dir,beforeMetadataCommit:()=>{ if(armed) { armed=false; acq.cancel(acq.records.latest()!.id); } }}); library.open();
    const callback=vi.fn(); acq=acquisition(callback);await acq.init();armed=true;
    const result=await acq.importFile({url:'https://books.example/a.txt',title:'海风'});
    expect(result.status).toBe('failed_recoverable');expect(result.failure?.code).toBe('cancelled');expect(callback).not.toHaveBeenCalled();expect(library.list()).toHaveLength(1);expect(library.list()[0].confirmedChars).toBe(0);
    const retry=await acq.retry(result.taskId);expect(retry.duplicate).toBe(true);expect(library.list()).toHaveLength(1);
  });
  it('retains a retryable original when shelf persistence fails, preserving earlier shelf data', async () => {
    library.close();let fail=false;library=new Library({dataDir:dir,beforeMetadataCommit:()=>{if(fail)throw Object.assign(Error('full'),{code:'ENOSPC'});}});library.open();
    const acq=acquisition();await acq.init();fail=true;const result=await acq.importFile({url:'https://books.example/a.txt',title:'海风'});
    expect(result.failure?.code).toBe('storage_unavailable');expect(library.list()).toHaveLength(0);expect(result.file?.retained).toBe(true);fail=false;expect((await acq.retry(result.taskId)).status).toMatch(/^completed/);expect(library.list()[0].confirmedChars).toBe(0);
  });
  it('retries idempotently if the task receipt fails after the shelf commit', async () => {
    const acq=acquisition();await acq.init();const original=acq.records.update.bind(acq.records);let fault=true;
    vi.spyOn(acq.records,'update').mockImplementation((id,fn,opts)=>{if(fault&&opts?.status?.startsWith('completed')){fault=false;throw Object.assign(Error('disk full'),{code:'ENOSPC'});}return original(id,fn,opts);});
    const result=await acq.importFile({url:'https://books.example/a.txt',title:'海风'});expect(result.status).toBe('failed_recoverable');expect(library.list()).toHaveLength(1);
    const retry=await acq.retry(result.taskId);expect(retry.duplicate).toBe(true);expect(library.list()).toHaveLength(1);expect(library.list()[0].confirmedChars).toBe(0);
  });
  it('recovers a raw commit interrupted before linking without a second download', async () => {
    const acq = acquisition(); await acq.init(); const fault = vi.spyOn(acq.staging, 'commitRaw').mockRejectedValueOnce(Object.assign(Error('busy'), { code: 'EBUSY' }));
    const failed = await acq.importFile({ url: 'https://books.example/a.txt', title: '海风' }); expect(failed.failure?.code).toBe('storage_unavailable');
    const pending = acq.records.get(failed.taskId)!.file!.pendingPart!; expect(existsSync(acq.staging.resolveInside(pending))).toBe(true); fault.mockRestore(); await acq.stop();
    const restarted = acquisition(); await restarted.init(); expect(restarted.records.get(failed.taskId)?.file?.pendingPart).toBeUndefined();
    const done = await restarted.retry(failed.taskId); expect(done.status).toMatch(/^completed/); expect(restarted.records.get(done.taskId)?.attempts.downloads).toBe(1); expect(library.list()).toHaveLength(1);
  });
  it('replays only queue integration after restart, preserving one unread shelf item', async () => {
    const acq = acquisition(() => { throw Error('queue unavailable'); }); await acq.init();
    const done = await acq.importFile({ url: 'https://books.example/a.txt', title: '海风' }); expect(done.selection?.status).toBe('failed'); await acq.stop();
    const callback = vi.fn(); const restarted = acquisition(callback); await restarted.init(); await restarted.resumeSelection(); await restarted.resumeSelection();
    expect(callback).toHaveBeenCalledOnce(); expect(restarted.records.get(done.taskId)?.selection?.status).toBe('completed'); expect(library.list()).toHaveLength(1); expect(library.list()[0].confirmedChars).toBe(0);
  });
  it('keeps persistent pending success when writing the queue receipt fails', async () => {
    let acq: TxtAcquisition; const callback = () => { mkdirSync(acq.records.file + '.' + process.pid + '.tmp'); };
    acq = acquisition(callback); await acq.init(); const done = await acq.importFile({ url: 'https://books.example/a.txt', title: '海风' });
    expect(done.status).toMatch(/^completed/); expect(done.selection?.status).toBe('pending'); expect(acq.selectionPersistenceError).toBeTruthy(); expect(library.list()[0].confirmedChars).toBe(0);
  });
  it('World stop during async queue integration leaves a replayable receipt', async () => {
    let release!: () => void; let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
    const acq = acquisition(async () => { entered(); await new Promise<void>(r => { release = r; }); }); await acq.init(); const running = acq.importFile({ url: 'https://books.example/a.txt', title: '海风' });
    await started; await acq.stop(); release(); const done = await running; expect(done.status).toMatch(/^completed/); expect(done.selection?.status).toBe('pending'); expect(library.list()).toHaveLength(1);
  });
  it('does not clean originals when task records are corrupt', async () => {
    const { acq, path } = await failedOriginal(); writeFileSync(acq.records.file, '{broken');
    const restarted = acquisition(); await expect(restarted.init()).rejects.toThrow(/original.*preserved/);
    expect(readFileSync(acq.records.file, 'utf8')).toBe('{broken'); expect(existsSync(path)).toBe(true);
  });
  it('surfaces statfs failure rather than claiming free disk space', async () => {
    const staging = new AcquisitionStaging(join(dir, 'staging')); await staging.init();
    vi.spyOn(disk, 'statfs').mockRejectedValueOnce(Object.assign(Error('offline'), { code: 'EIO' }));
    await expect(staging.freeBytes()).rejects.toMatchObject({ code: 'storage_unavailable' });
  });
  it('distinguishes deletion permissions from quota pressure and nothing to do', async () => {
    const staging = new AcquisitionStaging(join(dir, 'staging')); await staging.init(); const hash = 'a'.repeat(64); writeFileSync(join(staging.rawDir, hash + '.txt'), 'original');
    expect(await staging.enforceQuota(0, new Set([hash]))).toMatchObject({ status: 'over_quota_referenced', removed: [] });
    vi.spyOn(disk, 'rm').mockRejectedValueOnce(Object.assign(Error('denied'), { code: 'EACCES' }));
    expect(await staging.enforceQuota(0, new Set())).toMatchObject({ status: 'permission_denied', removed: [], errorCode: 'EACCES' }); expect(existsSync(join(staging.rawDir, hash + '.txt'))).toBe(true);
  });
  it('rechecks live references before deleting either extension of the same hash', async () => {
    const staging = new AcquisitionStaging(join(dir, 'staging')); await staging.init(); const hash = 'a'.repeat(64);
    for (const ext of ['txt','md']) writeFileSync(join(staging.rawDir, hash + '.' + ext), 'original');
    expect(await staging.enforceQuota(0, new Set(), () => false)).toMatchObject({ status: 'over_quota_referenced', removed: [] });
    expect(existsSync(join(staging.rawDir, hash + '.txt')) && existsSync(join(staging.rawDir, hash + '.md'))).toBe(true);
  });
  it.each(['byte', 'truncate', 'missing'] as const)('refuses %s mutation without importing or changing original digest', async mode => {
    const { acq, failed, path } = await failedOriginal();
    if (mode === 'missing') rmSync(path); else { const bytes = readFileSync(path); if (mode === 'byte') { bytes[100] ^= 1; writeFileSync(path, bytes); } else writeFileSync(path, bytes.subarray(0, bytes.length - 1)); }
    const result = await acq.retry(failed.taskId);
    expect(result.status).toBe('failed_recoverable'); expect(result.failure?.code).toMatch(/original_|storage_/); expect(library.list()).toHaveLength(0); expect(result.file?.sha256).toBe(failed.file?.sha256);
  });
  it('rolls back in-memory task changes when record persistence fails', async () => {
    const { acq, failed } = await failedOriginal(); const before = acq.records.get(failed.taskId)!;
    // A directory at the temporary filename deterministically denies write on every platform.
    const blocked = acq.records.file + '.' + process.pid + '.tmp'; mkdirSync(blocked);
    expect(() => acq.records.update(failed.taskId, t => { t.target.title = 'not durable'; })).toThrow();
    expect(acq.records.get(failed.taskId)).toEqual(before); expect(JSON.parse(readFileSync(acq.records.file, 'utf8')).tasks[0].target.title).toBe(before.target.title); expect(existsSync(blocked)).toBe(true);
  });
});
