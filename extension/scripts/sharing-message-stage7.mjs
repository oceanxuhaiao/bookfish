// Authorized bounded acceptance message. Ignore all replayed history.
import { writeFile } from 'node:fs/promises';
const name = 'Bookfish阶段7验收';
const quiet = process.argv[2] === 'quiet';
const guard = process.argv[2] === 'guard';
const text = guard ? '这是阶段7限额与冷却验收。请回查后续修订7c42b9be-c70c-44b3-9632-9c3f8842dec6，从它现有的谨慎修订里选一句简短感想，用bookfish_propose_share提名另一条不同候选。当前安静时段且当天分享验收额度已满，仅提名，不输出，不调用桌宠/语音；不要创建新手账、取新段或改配置。本次用于检查有候选时的限额与冷却拦截。' : quiet ? '这是阶段7安静时段的用户主动讨论验收。现在用户主动问：《西游记》那次怅然的原记录理由是什么？请回查已读记录后，用console_send在当前控制台简短回复，以[Bookfish阶段7主动讨论]开头。安静时段只拦自动分享，不应阻止本次主动提问。不要读新段、写手账/候选、调用语音或桌宠，也不改任何配置。' : '这是已授权的阶段7分享验收。请回查《西游记》记录7e8fe46c-52c7-4938-921d-ba89c4ec79fa及其修订，从已保存感想里选一句适合分享的短反应，用bookfish_propose_share提名候选。必须用你自己的自然口吻，别把工具协议写进分享，不带未读内容。现在只提名，不调用pet_say、语音或其他输出；之后若收到share_opportunity再按许可协议操作。不要读下一段、写新手账、改设置或内部记忆。提名后可在控制台简短说明已准备，不重复播报候选。';
const records = [{ at: new Date().toISOString(), kind: 'acceptance-message', name, text }];
const ws = new WebSocket('ws://127.0.0.1:17788/ws/providers/world%3Aconsole/panels/chat');
await new Promise(resolve => {
  ws.addEventListener('open', () => { ws.send(JSON.stringify({type:'hello',name})); ws.send(JSON.stringify({type:'msg',text})); });
  ws.addEventListener('message', e => { const f=JSON.parse(e.data); if(f.type==='msg' && f.from===name && f.text===text){records.push({kind:'echo-confirmed'});if(!quiet)ws.close();} else if(quiet && f.type==='msg' && typeof f.text==='string' && f.text.startsWith('[Bookfish阶段7主动讨论]')){records.push({at:new Date().toISOString(),kind:'specific-reply',text:f.text});ws.close();} });
  ws.addEventListener('close',resolve);ws.addEventListener('error',()=>{records.push({kind:'connection-error'});resolve();});setTimeout(()=>{ws.close();resolve();},30000).unref();
});
await writeFile(`output/live-stage7-message${quiet?'-quiet':guard?'-guard':''}.json`, JSON.stringify(records,null,2));console.log(JSON.stringify(records));
