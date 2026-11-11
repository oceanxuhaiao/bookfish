// Explicitly authorized, bounded model acceptance messages. Ignore replayed conversation history.
import { writeFile } from 'node:fs/promises';
const mode = process.argv[2] ?? 'read';
if (!['read', 'revise'].includes(mode)) throw new Error('Expected read or revise');
const name = 'Bookfish阶段5验收';
const text = mode === 'read'
  ? '这是已授权的阶段5阅读手账验收。请用bookfish工具读取当前《西游记》的下一段正文（只读一段，不要看未读内容或依赖已知剧情），读完后用finish_reading确认，并在episode中保存触发情节、你的当次解释、一段从本次正文逐字复制的唯一引用和简短自述理由；若你愿意明确报告此刻的阅读心情，可加mood，不想报告就省略，不编造感受、不输出隐藏推理。请按原文提取人物及别名和未决问题。不为此前两段补造当时感受。自主阅读保持关闭，不修改配置、人格或内部记忆。完成后简短回复即可。'
  : '这是已授权的阶段5追加修订验收。请先用bookfish_list_journal和bookfish_get_episode回查刚刚保存的阅读记录及原文。请把其中一处表述改得更谨慎、区分原文字面与自己的解释，用bookfish_record_reflection追加一条带revises指向原记录的修订；引用已读原文，解释这是现在重读后的补充，保留原判断，不把新说法或感受冒充之前就有。没有新心情就不填mood。不要读取下一段、不要修改配置、人格或内部记忆。';
const records = [{ at: new Date().toISOString(), mode, kind: 'acceptance-message', name, text }];
const ws = new WebSocket('ws://127.0.0.1:17788/ws/providers/world%3Aconsole/panels/chat');
await new Promise(resolve => {
  ws.addEventListener('open', () => { ws.send(JSON.stringify({ type: 'hello', name })); ws.send(JSON.stringify({ type: 'msg', text })); });
  ws.addEventListener('message', event => {
    const frame = JSON.parse(event.data);
    if (frame.type === 'msg' && frame.from === name && frame.text === text) {
      records.push({ at: new Date().toISOString(), kind: 'echo-confirmed' }); ws.close();
    }
  });
  ws.addEventListener('close', resolve);
  ws.addEventListener('error', () => { records.push({ kind: 'connection-error' }); resolve(); });
  setTimeout(() => { ws.close(); resolve(); }, 30000).unref();
});
await writeFile(`output/live-stage5-message-${mode}.json`, JSON.stringify(records, null, 2));
console.log(JSON.stringify(records));
