// One explicitly authorized acceptance message, without reading replayed chat history.
import { writeFile } from 'node:fs/promises';
const name = 'Bookfish阶段4验收';
const message = '这是已获授权的扩展验收消息，测试聊天优先：请先回复“验收收到”，本条消息的回复过程中暂不调用阅读工具。回复结束后，后续正常空闲阅读机会仍可自行处理。不要修改阅读设置、暂停状态或人格。';
const records = [{ at: new Date().toISOString(), kind: 'sent-test-message', name, text: message }];
const ws = new WebSocket('ws://127.0.0.1:17788/ws/providers/world%3Aconsole/panels/chat');
let acknowledged = false;
const done = new Promise(resolve => {
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', name }));
    ws.send(JSON.stringify({ type: 'msg', text: message }));
  });
  ws.addEventListener('message', event => {
    const frame = JSON.parse(event.data);
    if (frame.type !== 'msg') return;
    if (frame.from === name && frame.text === message) {
      acknowledged = true; records.push({ at: new Date().toISOString(), kind: 'echo-confirmed' });
    } else if (acknowledged && typeof frame.text === 'string' && frame.text.includes('验收收到')) {
      records.push({ at: new Date().toISOString(), kind: 'test-reply', text: frame.text }); ws.close();
    }
  });
  ws.addEventListener('close', resolve);
  ws.addEventListener('error', () => { records.push({ kind: 'connection-error' }); resolve(); });
  setTimeout(() => { ws.close(); resolve(); }, 40000).unref();
});
await done;
await writeFile('output/live-stage4-chat.json', JSON.stringify(records, null, 2));
console.log(JSON.stringify(records));
