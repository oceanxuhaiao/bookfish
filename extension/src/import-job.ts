import { Worker } from 'node:worker_threads';
import { mkdirSync, readdirSync, lstatSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export interface ImportState {id:string;state:'processing'|'committing'|'done'|'failed'|'cancelled';stage:string;percent:number;error?:string;result?:unknown}
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
/** Flat owned staging only: never follow links or recursively remove a directory. */
export function cleanImportDirectory(root:string,name:string){
  if(!new RegExp('^'+uuid+'\\.import$').test(name))throw Error('Invalid import directory');
  const dir=resolve(root,name);if(resolve(root)!==resolve(dir,'..'))throw Error('Import directory escaped root');
  if(!existsSync(dir))return;const st=lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink())throw Error('Unexpected import path');
  const names=readdirSync(dir);for(const file of names){if(!new RegExp('^(?:'+uuid+'(?:\\.canonical)?\\.tmp|[a-f0-9]{64}\\.json\\.gz)$').test(file)||!lstatSync(join(dir,file)).isFile()||lstatSync(join(dir,file)).isSymbolicLink())throw Error('Unexpected file in import staging');}
  for(const file of names)unlinkSync(join(dir,file));rmdirSync(dir);
}
export class ImportJob {
  readonly status:ImportState;
  private worker:Worker;
  readonly ended:Promise<void>;
  constructor(readonly root:string,readonly id:string,file:string,metadata:unknown,commit:(file:string,id:string,receipt:{size:number;mtimeMs:number})=>unknown,cleanup:()=>void){
    const dir=join(root,id+'.import');mkdirSync(dir);this.status={id,state:'processing',stage:'normalize',percent:0};
    // Resolve from this module's directory without the `new URL(..., import.meta.url)` pattern,
    // which browser-oriented bundlers rewrite to an http URL and worker_threads rejects.
    try{const workerFile=join(dirname(fileURLToPath(import.meta.url)),'..','lib','import-worker.mjs');this.worker=new Worker(workerFile,{workerData:{dir,file,metadata},execArgv:[]});}catch(error){cleanImportDirectory(root,id+'.import');throw error;}
    let doneMessage:any,errorMessage:string|undefined;
    this.worker.on('message',(m)=>{if(this.status.state!=='processing')return;if(m.type==='progress'){this.status.stage=m.stage;const ratio=m.total?Math.max(0,Math.min(1,m.done/m.total)):0;this.status.percent=Math.max(this.status.percent,m.stage==='normalize'?Math.floor(ratio*30):m.stage==='index'?30+Math.floor(ratio*45):75);}else if(m.type==='done')doneMessage=m;else if(m.type==='error')errorMessage=String(m.error).slice(0,500);});
    this.worker.on('error',e=>{errorMessage=e.message.slice(0,500);});
    this.ended=new Promise<void>(resolveEnd=>this.worker.once('exit',code=>{
      try{if(this.status.state!=='cancelled'){
        if(code!==0||errorMessage||!doneMessage)throw Error(errorMessage??'Import worker stopped before completion');
        if(!/^[a-f0-9]{64}$/.test(doneMessage.id))throw Error('Invalid worker result');
        this.status.state='committing';this.status.stage='commit';this.status.percent=95;
        this.status.result=commit(join(dir,doneMessage.id+'.json.gz'),doneMessage.id,doneMessage.receipt);
        this.status.state='done';this.status.stage='done';this.status.percent=100;
      }}catch(e){this.status.state='failed';this.status.error=e instanceof Error?e.message:String(e);}
      finally{try{cleanImportDirectory(root,id+'.import');cleanup();}catch(e){if(this.status.state!=='done'){this.status.error=String(e);this.status.state='failed';}}resolveEnd();}
    }));
  }
  async cancel(){if(this.status.state==='processing'){this.status.state='cancelled';this.status.stage='cancelled';await this.worker.terminate();}await this.ended;}
}

