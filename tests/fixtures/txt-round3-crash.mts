/** Isolated process-exit fixture. Never references production paths or model endpoints. */
import { Library } from '../../src/library.ts';
import { TxtAcquisition } from '../../src/txt-acquisition/acquisition.ts';
import { BOOKFISH_DEFAULTS } from '../../src/config.ts';
import { resolve } from 'node:path';
const [dir,phase]=process.argv.slice(2);if(!dir||!phase)throw Error('fixture dataDir/phase required');
let armed=false;
const library=new Library({dataDir:resolve(dir),beforeMetadataCommit:()=>{if(armed&&phase==='metadata')process.exit(23);}});library.open();
const acq=new TxtAcquisition({dataDir:resolve(dir),library,cfg:()=>({...BOOKFISH_DEFAULTS,txtAcquisitionEnabled:true}),resolve:async()=>['93.184.216.34'],fetchImpl:(async()=>new Response('她把信折好，走向窗边。'.repeat(100))) as typeof fetch});
await acq.init();
if(phase==='recover'){
 const task=acq.records.latest();if(!task)throw Error('Missing recovery record');const result=await acq.retry(task.id);if(!result.status.startsWith('completed'))throw Error(JSON.stringify(result));
 const books=library.list();if(books.length!==1||books[0].confirmedChars!==0||library.timeline(books[0].key).items.length)throw Error('Invalid recovered shelf');
 console.log(JSON.stringify({phase,result:result.status,books:books.length,confirmedChars:books[0].confirmedChars,downloads:acq.records.get(task.id)!.attempts.downloads}));
}else{
 if(phase==='raw'){const original=acq.staging.commitRaw.bind(acq.staging);acq.staging.commitRaw=async(...args)=>{await original(...args);process.exit(23);};}
 if(phase==='prepared')library.importFileBestEffort=()=>process.exit(23);
 if(phase==='book'){const original=library.importFileBestEffort.bind(library);library.importFileBestEffort=(...args)=>{original(...args);process.exit(23);};}
 if(phase==='task'){const original=acq.records.update.bind(acq.records);acq.records.update=(id,fn,opts)=>{if(opts?.status?.startsWith('completed'))process.exit(23);return original(id,fn,opts);};}
 armed=true;await acq.importFile({url:'https://fixture.example/a.txt',title:'中断夹具'});throw Error('Expected forced process exit');
}
await acq.stop();library.close();
