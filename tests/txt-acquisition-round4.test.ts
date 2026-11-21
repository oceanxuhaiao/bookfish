import {describe,it,expect,afterEach,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,symlinkSync,rmSync,utimesSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID,createHash} from 'node:crypto';
import {AcquisitionStaging} from '../src/txt-acquisition/staging.ts';
import {assessText} from '../src/txt-acquisition/quality.ts';
const dirs:string[]=[];const scratch=()=>{const d=mkdtempSync(join(tmpdir(),'bf-r4-'));dirs.push(d);return d;};
afterEach(()=>{vi.restoreAllMocks();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
describe('round4 staging boundaries',()=>{
  it.skipIf(process.platform==='win32')('rejects POSIX directory symlinks before cleanup',async()=>{
    const base=scratch(),outside=join(base,'outside');mkdirSync(outside);const staging=new AcquisitionStaging(join(base,'area'));await staging.init();renameSync(staging.workDir,staging.workDir+'.old');symlinkSync(outside,staging.workDir,'dir');await expect(staging.clearExpiredParts()).rejects.toThrow();
  });
  it.each(['init','prepared','verified','part','quota','commit','drop','download'] as const)('guards %s after a Windows junction / POSIX symlink replacement',async action=>{
    const base=scratch(),outside=join(base,'outside');mkdirSync(outside);const staging=new AcquisitionStaging(join(base,'area'));await staging.init();const part=staging.partialPath(randomUUID()),bytes=Buffer.from('trusted');writeFileSync(part,bytes);const digest=createHash('sha256').update(bytes).digest('hex');
    const raw=action==='quota'||action==='commit'||action==='drop',directory=raw?staging.rawDir:staging.workDir,name=action==='prepared'?randomUUID()+'.prepared.txt':action==='verified'?randomUUID()+'.verified.txt':raw?digest+'.txt':randomUUID()+'.part';
    const sentinel=join(outside,name);writeFileSync(sentinel,'external must survive');utimesSync(sentinel,0,0);renameSync(directory,directory+'.old');symlinkSync(outside,directory,process.platform==='win32'?'junction':'dir');
    const operation=async()=>{if(action==='init')await staging.init();else if(action==='prepared'||action==='verified')await staging.clearAbandonedPrepared();else if(action==='part')await staging.clearExpiredParts();else if(action==='quota')await staging.enforceQuota(0,new Set());else if(action==='commit')await staging.commitRaw(part,digest,'txt');else if(action==='drop')await staging.removeIfPresent(join(staging.rawDir,name));else await staging.beginDownload(randomUUID());};
    let refused=false;try{await operation();refused=action==='drop';}catch{refused=true;}expect(refused).toBe(true);expect(readFileSync(sentinel,'utf8')).toBe('external must survive');expect(readdirSync(outside)).toEqual([name]);
  });
  it.each(['raw','work','root'] as const)('refuses redirected %s before any maintenance touches the external sentinel',async kind=>{
    const base=scratch(),root=join(base,'area'),outside=join(base,'outside');mkdirSync(outside);const staging=new AcquisitionStaging(root);await staging.init();
    const name=kind==='raw'?'a'.repeat(64)+'.txt':randomUUID()+'.verified.txt';const sentinel=join(outside,name);writeFileSync(sentinel,'outside must survive');utimesSync(sentinel,0,0);
    const replaced=kind==='root'?root:join(root,kind);renameSync(replaced,replaced+'-original');symlinkSync(outside,replaced,process.platform==='win32'?'junction':'dir');
    const action=kind==='raw'?()=>staging.enforceQuota(0,new Set()):()=>staging.clearAbandonedPrepared();let refused=false;try{const result=await action();refused=!!result&&'status' in result&&result.status!=='success';}catch{refused=true;}expect(refused).toBe(true);expect(readFileSync(sentinel,'utf8')).toBe('outside must survive');
  });
  it('rejects replacement after commitRaw hashing instead of publishing different bytes',async()=>{
    const staging=new AcquisitionStaging(scratch());await staging.init();const input=staging.partialPath(randomUUID()),bytes=Buffer.from('authenticated original');writeFileSync(input,bytes);const sha=createHash('sha256').update(bytes).digest('hex');const original=staging.hashFile.bind(staging);vi.spyOn(staging,'hashFile').mockImplementationOnce(async(...args)=>{const result=await original(...args);renameSync(input,input+'.old');writeFileSync(input,'unauthenticated bytes');return result;});await expect(staging.commitRaw(input,sha,'txt')).rejects.toThrow();
  });
});
describe('round4 metadata identity',()=>{
  it.each([['海风','海风传','小鱼','小鱼'],['红楼梦','红楼梦续','曹雪芹','曹雪芹'],['海风','海风','鲁迅','鲁迅传'],['海风','海风（修订版）','小鱼','小鱼']])('does not label differing metadata exact: %s / %s', (title,other,author,otherAuthor)=>{
    const q=assessText({text:'她打开信封，读起那封迟来的信。'.repeat(100),encoding:'utf-8',repairs:[],replacements:0,truncatedTail:false,wanted:{title,author},declared:{title:other,author:otherAuthor}});expect(q.verdict).toBe('accept');expect(q.identity).not.toBe('exact');
  });
});
