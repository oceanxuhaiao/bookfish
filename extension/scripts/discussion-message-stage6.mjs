// Explicitly authorized actual-Persona integration. Ignore all replayed/private history.
import { writeFile } from 'node:fs/promises';
const name = 'Bookfish阶段6验收';
const marker = '[Bookfish阶段6回查结果]';
const text = `这是已授权的阶段6只读讨论验收。请实际使用新工具bookfish_search_reading和bookfish_get_reading_context回查《西游记》：之前那次“意料之外的怅然”为什么产生？后来对“第一次”“不知足”如何修订？此前没有独立手账的两段能否确认当时感受和理由？请给原记录与修订的编号和原文位置，简短回答，分清当时/后来/未知。不要取下一段、联网、写新记录或改设置/人格/内部记忆，自主阅读保持关闭。为便于验收，请使用console_send在当前控制台输出以${marker}开头的完整答复。`;
const records = [{ at: new Date().toISOString(), kind: 'acceptance-message', name, text }];
const ws = new WebSocket('ws://127.0.0.1:17788/ws/providers/world%3Aconsole/panels/chat');
let echoed = false;
await new Promise(resolve => {
  ws.addEventListener('open', () => { ws.send(JSON.stringify({ type: 'hello', name })); ws.send(JSON.stringify({ type: 'msg', text })); });
  ws.addEventListener('message', event => {
    const frame = JSON.parse(event.data);
    if (frame.type !== 'msg') return;
    if (frame.from === name && frame.text === text) { echoed = true; records.push({ kind: 'echo-confirmed' }); }
    else if (echoed && typeof frame.text === 'string' && frame.text.startsWith(marker)) { records.push({ at: new Date().toISOString(), kind: 'specific-acceptance-reply', text: frame.text }); ws.close(); }
  });
  ws.addEventListener('close', resolve);
  ws.addEventListener('error', () => { records.push({ kind: 'connection-error' }); resolve(); });
  setTimeout(() => { ws.close(); resolve(); }, 55000).unref();
});
await writeFile('output/live-stage6-conversation.json', JSON.stringify(records, null, 2));
console.log(JSON.stringify(records));
