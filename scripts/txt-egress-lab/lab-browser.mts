/** Own-process pipe transport, only for explicitly isolated browser experiments. */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
export class LabBrowser {
  readonly child: ChildProcess; readonly events: Array<{method:string;params:any;sessionId?:string}> = []; private closed=false; private serial=0; private buffer=Buffer.alloc(0);
  private pending=new Map<number,{ok:(v:any)=>void;no:(e:Error)=>void;timer:NodeJS.Timeout}>();
  constructor(executable:string,args:string[]) {
    this.child=spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe','pipe','pipe']});
    this.child.stdio[4]!.on('data',(chunk:Buffer)=>{this.buffer=Buffer.concat([this.buffer,chunk]);let end:number;while((end=this.buffer.indexOf(0))>=0){const raw=this.buffer.subarray(0,end).toString();this.buffer=this.buffer.subarray(end+1);if(!raw)continue;const frame=JSON.parse(raw);if(frame.method && this.events.length<5000)this.events.push({method:frame.method,params:frame.params,sessionId:frame.sessionId});const p=this.pending.get(frame.id);if(p){clearTimeout(p.timer);this.pending.delete(frame.id);frame.error?p.no(new Error(JSON.stringify(frame.error))):p.ok(frame.result);}}});
    const streamError=(error:Error)=>{for(const item of this.pending.values()){clearTimeout(item.timer);item.no(error);}this.pending.clear();};
    for(const stream of this.child.stdio)stream?.on('error',streamError);this.child.stdout?.resume();this.child.stderr?.resume();this.child.on('error',streamError);
    this.child.on('exit',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.no(new Error('Isolated browser exited'));}this.pending.clear();});
  }
  send(method:string,params:any={},sessionId?:string):Promise<any>{return new Promise((ok,no)=>{const id=++this.serial;const timer=setTimeout(()=>{this.pending.delete(id);no(new Error('CDP timeout '+method));},12000);this.pending.set(id,{ok,no,timer});(this.child.stdio[3] as NodeJS.WritableStream).write(JSON.stringify({id,method,params,sessionId})+'\0');});}
  async attach(targetId:string):Promise<string>{return (await this.send('Target.attachToTarget',{targetId,flatten:true})).sessionId;}
  async evaluate(sessionId:string,expression:string,userGesture=false):Promise<any>{const result=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture},sessionId);if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??'Evaluation failed');return result.result?.value;}
  async page(url:string):Promise<string>{const {targetId}=await this.send('Target.createTarget',{url});const session = await this.attach(targetId); await until(async()=>{try{return await this.evaluate(session,'document.readyState === "complete"');}catch{return false;}},'lab page loaded',10000);return session;}
  async close():Promise<void>{if(this.closed)return;this.closed=true;if(this.child.pid&&this.child.exitCode===null){try{execFileSync('taskkill',['/PID',String(this.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}await new Promise(ok=>setTimeout(ok,300));}
}
export async function until(check:()=>boolean|Promise<boolean>,message:string,timeout=15000):Promise<void>{const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(ok=>setTimeout(ok,100));}throw Error('Timed out: '+message);}
