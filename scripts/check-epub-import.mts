/** Import a real EPUB through the production upload → worker → library path.
 * Usage: node --import tsx scripts/check-epub-import.mts <file.epub> */
import { mkdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Library } from '../src/library.ts';
import { BookTransfers } from '../src/transfers.ts';

const file = process.argv[2] ?? 'E:/项目/桌面宠物/扩展/看书吧！大肥鱼/output/epub-test/santi.epub';
const root = join(process.cwd(), 'output', `epub-import-${Date.now()}`);
mkdirSync(root, { recursive: true });
const library = new Library({ dataDir: join(root, 'library') });
library.open();
library.clear();
const transfers = new BookTransfers(library);
const began = Date.now();
const data = readFileSync(file);
const size = statSync(file).size;
const begin = transfers.begin({ kind: 'book', filename: file.split(/[\\/]/u).pop(), autoMetadata: true, size }) as { id: string; chunkBytes: number };
const chunk = begin.chunkBytes;
for (let offset = 0; offset < size; offset += chunk) {
  const slice = data.subarray(offset, offset + chunk);
  transfers.chunk(begin.id, offset, slice.toString('base64'));
}
const started = transfers.start(begin.id) as { id: string };
let status = transfers.status(begin.id) as { state: string; stage: string; percent: number; error?: string; result?: { duplicate: boolean; book: { key: string; title: string; author: string; totalChars: number; identifiedChapters: number } } };
const deadline = Date.now() + 180_000;
while (!['done', 'failed', 'cancelled'].includes(status.state) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  status = transfers.status(begin.id) as typeof status;
}
const result = {
  file, size, state: status.state, stage: status.stage, error: status.error ?? null,
  ms: Date.now() - began,
  book: status.result?.book ? {
    title: status.result.book.title, author: status.result.book.author,
    totalChars: status.result.book.totalChars, identifiedChapters: status.result.book.identifiedChapters,
    duplicate: status.result.duplicate,
  } : null,
  shelf: library.list().map((book) => ({ title: book.title, author: book.author, chapters: book.identifiedChapters, chars: book.totalChars })),
};
console.log(JSON.stringify(result, null, 2));
transfers.close();
library.close();
if (status.state !== 'done') process.exitCode = 1;
else rmSync(root, { recursive: true, force: true });
