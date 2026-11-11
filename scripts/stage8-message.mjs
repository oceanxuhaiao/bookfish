// Authorized acceptance; saves only this test's message/echo/specific reply, never replayed history.
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
const mode = process.argv[2] ?? 'wait';
const messages = {
  wait: '这是阶段8整体验收：已导入并选中原创短篇《多出来的一枚硬币（阶段8验收）》并开启5分钟自主阅读。请等待正常bookfish.reading_opportunity，不要提前手动取段，不要改设置或内部记忆。收到机会后正常读本次正文，确认时保存值得记住的真实反应、简短理由、精确引用和你愿意报告的心情；可选一条自然短感想提名分享候选，但先不输出。自动读后感暂时关闭，之后会在讨论/分享验收后开启。现在无需对用户播报。',
  nominate: '阶段8验收：请从刚刚读完《多出来的一枚硬币（阶段8验收）》的已有感想中提名一条你自己的短分享，用bookfish_propose_share，只提名、不输出。不要再读、写新手账或改设置。若已有该书候选，就保留它，不重复提名。',
  rewrite: '阶段8版本验收：请为刚刚已完整读过的《多出来的一枚硬币（阶段8验收）》明确重写第二版读后感。先begin_review用新的ASCII requestId，再分页回查ranges和episodes，最后finish_review保存。保留第一版不覆盖，把现在新增解读明确写成现在的看法，忠于保存的感想和原文，别写通用剧情梗概。不要再读新段、写新手账、发桌宠或改设置。',
};
const text = messages[mode] ?? await readFile(mode, 'utf8');
const name = 'Bookfish阶段8验收'; const records = [{ at: new Date().toISOString(), mode, name, text }];
const ws = new WebSocket('ws://127.0.0.1:17788/ws/providers/world%3Aconsole/panels/chat');
await new Promise(resolve => {
  ws.addEventListener('open', () => { ws.send(JSON.stringify({type:'hello',name}));ws.send(JSON.stringify({type:'msg',text})); });
  ws.addEventListener('message', e => { const f=JSON.parse(e.data);if(f.type==='msg'&&f.from===name&&f.text===text){records.push({kind:'echo-confirmed'});ws.close();} });
  ws.addEventListener('close',resolve);ws.addEventListener('error',()=>{records.push({kind:'connection-error'});resolve();});setTimeout(()=>{ws.close();resolve();},30000).unref();
});
await writeFile(`output/live-stage8-message-${Object.hasOwn(messages,mode)?mode:basename(mode).replace(/[^A-Za-z0-9_-]/g,'_')}.json`,JSON.stringify(records,null,2));console.log(JSON.stringify({mode,echo:records.some(r=>r.kind==='echo-confirmed')}));
