import { mkdirSync,readFileSync,writeFileSync,openSync,writeSync,closeSync,statSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { Library } from '../src/library.ts';import { HistoryStore } from '../src/history.ts';
const mode=process.argv[2]??'prepare',root=resolve('output/large-file-check/history-fixture');mkdirSync(root,{recursive:true});const count=20000;
const id=(n:number)=>{const s=n.toString(16).padStart(32,'0');return s.slice(0,8)+'-'+s.slice(8,12)+'-'+s.slice(12,16)+'-'+s.slice(16,20)+'-'+s.slice(20);};
if(mode==='prepare'){
 const baseLib=new Library({dataDir:join(root,'paged')});baseLib.open();const book=baseLib.import({filename:'stress.txt',title:'历史压力合成样本',base64:Buffer.from('海风。').toString('base64')}).book;baseLib.select(book.key);const t=baseLib.readNext();baseLib.finish({...t,understanding:'仅用于独立存储验证',episode:{trigger:'风起',interpretation:'合成初始记录',mood:{label:'平静'},evidence:[{segmentId:0,quote:'海风。'}]}});const state=JSON.parse(JSON.parse(baseLib.export()).payload);baseLib.close();
 const first=state.episodes[0],task=state.tasks[0];
 const episode=(n:number)=>n===0?first:{id:id(n+1000000),sequence:n+1,bookKey:book.key,recordedAt:new Date(1700000000000+n).toISOString(),kind:n%1000===0?'revision':'reflection',requestId:'stress-'+n,...(n%1000===0?{revises:first.id}:{}),content:{...first.content,trigger:'独立压力记录'+n,interpretation:'这是合成记录，用来验证长期手账分页。'.repeat(30),reason:'这里仅是存储测试，不代表大肥鱼实际阅读。'.repeat(20),mood:null,characters:[{name:'小鱼',aliases:['测试鱼']}],relatedEpisodeIds:[]}};
 const offer=(n:number)=>n===0?task:{id:id(n+2000000),bookKey:book.key,segmentId:0,generation:task.generation,expiresAt:task.expiresAt,status:'cancelled'};
 const virtual=(get:(n:number)=>any)=>new Proxy(new Array(count+1),{get:(target,key,receiver)=>typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key)?get(Number(key)):Reflect.get(target,key,receiver),has:()=>true});
 state.tasks=virtual(offer);state.episodes=virtual(episode);state.nextEpisodeSequence=count+2;
 const db=new HistoryStore(join(root,'paged','bookfish','history.sqlite'));db.open();const ref=db.prepare(state);db.committed(ref);db.close();writeFileSync(join(root,'paged','bookfish','library.json'),JSON.stringify({...state,tasks:[],episodes:[],schema:6,$history:ref}));
 const legacy=join(root,'baseline','bookfish');mkdirSync(legacy,{recursive:true});const fd=openSync(join(legacy,'library.json'),'w');const put=(s:string)=>{const b=Buffer.from(s);let at=0;while(at<b.length)at+=writeSync(fd,b,at,b.length-at);};
 try{const {tasks,episodes,...meta}=state;put(JSON.stringify({...meta,schema:5}).slice(0,-1)+',"tasks":[');for(let n=0;n<=count;n++)put((n?',':'')+JSON.stringify(offer(n)));put('],"episodes":[');for(let n=0;n<=count;n++)put((n?',':'')+JSON.stringify(episode(n)));put(']}');}finally{closeSync(fd);}
 writeFileSync(join(root,'fixture.json'),JSON.stringify({bookKey:book.key,episodeId:first.id,count,legacyBytes:statSync(join(legacy,'library.json')).size,sqliteBytes:statSync(join(root,'paged','bookfish','history.sqlite')).size}));console.log('Prepared '+count+' synthetic tasks and reflections');
}else{
 const Ctor=mode==='baseline'?(await import('file:///E:/zcdfy/Coopanion/data/local-extensions/bookfish-0.14.0/src/library.ts')).Library:Library;
 const lib=new Ctor({dataDir:join(root,mode==='baseline'?'baseline':'paged')}),fixture=JSON.parse(readFileSync(join(root,'fixture.json'),'utf8')),snapshots:any[]=[];
 const snap=(label:string)=>snapshots.push({label,...process.memoryUsage(),maxRssKiB:process.resourceUsage().maxRSS,cache:lib.storageStats()});
 snap('cold');let start=Date.now();lib.open();const openMs=Date.now()-start;snap('open');start=Date.now();const page=lib.journal(undefined,undefined,5);const journalMs=Date.now()-start;if(page.total<count+1||page.items.length!==5)throw Error('Journal page mismatch');snap('journal');start=Date.now();lib.journal(undefined,undefined,5);const warmJournalMs=Date.now()-start;
 start=Date.now();lib.context({episodeIds:[fixture.episodeId]});const contextMs=Date.now()-start;snap('context');start=Date.now();lib.reflect({bookKey:fixture.bookKey,requestId:'after-stress-'+mode,episode:{trigger:'压力后的追加',interpretation:'合成记录追加验证',evidence:[{segmentId:0,quote:'海风。'}]}});const appendMs=Date.now()-start;snap('append');
 const backup=join(root,mode+'-'+Date.now()+'.bfbak');writeFileSync(join(root,mode+'-latest.txt'),backup);start=Date.now();lib.writeArchive(backup);const backupMs=Date.now()-start;snap('backup');const metadataBytes=statSync(lib.file).size;lib.close();snap('closed');
 const proof={mode,count,recordsBefore:page.total,openMs,journalMs,warmJournalMs,contextMs,appendMs,backupMs,metadataBytes,maxRssKiB:process.resourceUsage().maxRSS,backupBytes:statSync(backup).size,snapshots,modelUsed:false};writeFileSync('output/history-memory-'+mode+'-0.15.0.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}
