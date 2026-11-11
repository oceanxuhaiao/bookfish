import type {BookfishConfigSection} from './config.ts';
export const ROUTINE_DEFAULTS={sleepStartMinute:1380,sleepEndMinute:480,breakfastStartMinute:480,breakfastEndMinute:510,lunchStartMinute:720,lunchEndMinute:780,dinnerStartMinute:1080,dinnerEndMinute:1140};
export function readingRoutine(cfg:BookfishConfigSection,now:number,timezone:string){
 if(cfg.realRoutineEnabled===false)return null;
 const minute=(key:keyof typeof ROUTINE_DEFAULTS)=>ROUTINE_DEFAULTS[key];
 const windows=[{kind:'sleep',label:'睡觉',start:minute('sleepStartMinute'),end:minute('sleepEndMinute')},...(['breakfast','lunch','dinner'] as const).map((kind,i)=>({kind,label:['吃早餐','吃午餐','吃晚餐'][i],start:minute(`${kind}StartMinute`),end:minute(`${kind}EndMinute`)}))];
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now),at=Number(parts.find(p=>p.type==='hour')!.value)*60+Number(parts.find(p=>p.type==='minute')!.value);
 const blocked=(m:number)=>windows.find(w=>(w.start===w.end||w.start<w.end? w.start===w.end||m>=w.start&&m<w.end:m>=w.start||m<w.end));
 const current=blocked(at);if(!current)return null;let delta=1;while(delta<=1440&&blocked((at+delta)%1440))delta++;const until=delta>1440?null:(at+delta)%1440;
 return {kind:current.kind,label:current.label,until:until===null?null:String(Math.floor(until/60)).padStart(2,'0')+':'+String(until%60).padStart(2,'0'),timezone};
}
