import { AcquisitionStaging } from '../src/txt-acquisition/staging.ts';
import { resolve,join } from 'node:path';
import { writeFileSync,readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const staging=new AcquisitionStaging(resolve('_verify/filesystem-faults'));await staging.init();
const bytes=Buffer.from('她把信折好，海风吹过窗口。'.repeat(40)),sha256=createHash('sha256').update(bytes).digest('hex'),path=join('raw',sha256+'.txt');
if(process.argv[2]==='init'){writeFileSync(staging.resolveInside(path),bytes);console.log(staging.resolveInside(path));}
else{
 const result=await staging.verifiedOriginal({path,sha256,bytes:bytes.length}).then(async snapshot=>{await staging.removeIfPresent(snapshot);return {verified:true};},error=>({verified:false,code:error.code,message:error.message}));
 if(process.argv[2]==='verify'){if(!result.verified)throw Error(JSON.stringify(result));if(!readFileSync(staging.resolveInside(path)).equals(bytes))throw Error('Original changed');}
 else if(result.verified||!('code'in result)||result.code!=='storage_unavailable')throw Error('Expected actual filesystem denial: '+JSON.stringify(result));
 console.log(JSON.stringify(result));
}
