/** Live host EPUB import: chunked upload -> worker -> shelf -> remove. */
import { readFileSync, writeFileSync } from 'node:fs';

const base = 'http://127.0.0.1:17788/api/webui/providers/world%3Abookfish/panels/';
const file = process.argv[2] ?? 'E:/项目/桌面宠物/扩展/看书吧！大肥鱼/output/epub-test/santi.epub';

async function call(panel, method, args = []) {
  const response = await fetch(`${base}${panel}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const data = readFileSync(file);
const before = await call('status', 'get');
const beforeBooks = before.books.length;
const startedAt = Date.now();
const begin = await call('shelf', 'upload_begin', [{ kind: 'book', filename: '三体（全集）.epub', autoMetadata: true, size: data.length }]);
for (let offset = 0; offset < data.length; offset += begin.chunkBytes) {
  const slice = data.subarray(offset, offset + begin.chunkBytes);
  await call('shelf', 'upload_chunk', [begin.id, offset, slice.toString('base64')]);
}
const started = await call('shelf', 'upload_finish', [begin.id]);
let status = await call('shelf', 'transfer_status', [begin.id]);
const deadline = Date.now() + 180_000;
while (!['done', 'failed', 'cancelled'].includes(status.state) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 800));
  status = await call('shelf', 'transfer_status', [begin.id]);
}
const book = status.result?.book ?? null;
const evidence = {
  startedAt: new Date().toISOString(),
  file, bytes: data.length, state: status.state, stage: status.stage, error: status.error ?? null,
  ms: Date.now() - startedAt,
  book: book ? { key: book.key, title: book.title, author: book.author, chapters: book.identifiedChapters, chars: book.totalChars, duplicate: status.result?.duplicate } : null,
  beforeBooks,
};
if (book) {
  await call('shelf', 'remove', [book.key]);
  const after = await call('status', 'get');
  evidence.afterBooks = after.books.length;
  evidence.removed = after.books.length === beforeBooks;
}
writeFileSync('output/live-epub-0.59.0.json', `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(evidence, null, 2));
process.exitCode = status.state === 'done' && evidence.removed !== false ? 0 : 1;
