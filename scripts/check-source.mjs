import { SourceHttp } from '../src/source-http.ts';
import { Library } from '../src/library.ts';
import { Sources } from '../src/sources.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const http = new SourceHttp();
const requests = [];
const get = async (url, signal) => { requests.push(url); return http.get(url, signal); };
await mkdir('output', { recursive: true });
const dataDir = join(process.cwd(), 'output/source-fixture', randomUUID());
const library = new Library({ dataDir });
let recovery;
try {
  library.open(); library.clear();
  const sources = new Sources(library, get);
  const imported = await sources.resolve('https://www.02345.cc/xiyouji/1292291/');
  if (!imported.book?.source || imported.book.source.cachedChapters !== 1) throw Error('First complete chapter was not cached');
  library.select(imported.book.key);
  const zero = library.status();
  let firstText;
  while (library.status().current.confirmedSegments < library.status().current.totalSegments) {
    const t = library.readNext(); if (t.complete) throw Error('Premature completion');
    firstText ??= t.segment.text;
    library.finish({ taskId: t.taskId, bookKey: t.bookKey, segmentId: t.segmentId, understanding: 'This is a mechanical protocol-test confirmation, not a model comprehension result.' });
  }
  const firstDone = library.status();
  await sources.ensureNext();
  const appended = library.status();
  const pending = library.readNext();
  const backup = library.export();
  library.close(); library.open();
  let staleRejected = false;
  try { library.finish({ taskId: pending.taskId, bookKey: pending.bookKey, segmentId: pending.segmentId, understanding: 'stale' }); } catch { staleRejected = true; }
  recovery = new Library({ dataDir: join(dataDir, 'restore') }); recovery.open(); recovery.clear(); recovery.restore(backup);
  const snapshot = JSON.parse(JSON.parse(library.export()).payload);
  const remote = snapshot.books[0].book.remote;
  const result = {
    checkedAt: new Date().toISOString(), bookUrl: remote.catalog.bookUrl, title: remote.catalog.title, author: remote.catalog.author,
    catalogChapters: remote.catalog.chapters.length, catalogHash: remote.catalog.hash,
    cachedChapters: remote.cache.map((chapter) => ({ index: chapter.index, title: remote.catalog.chapters[chapter.index].title, pages: chapter.pages, chars: Array.from(chapter.text).length, hash: chapter.hash })),
    checks: { fetchDidNotAdvance: zero.current.confirmedChars === 0, cachedPrefixNotWholeBook: !firstDone.current.complete,
      chapterProgress: firstDone.current.source.confirmedChapters === 1, continuedToSecondChapter: appended.current.source.cachedChapters === 2,
      prefixUnchanged: library.reread(imported.book.key, 0).segment.text === firstText,
      progressSurvivedRestart: library.status().current.confirmedChars === firstDone.current.confirmedChars,
      staleTaskRejected: staleRejected, backupRestored: recovery.status().current.source.cachedChapters === 2 },
    requestCount: requests.length, textOmitted: true,
    limits: 'Real source HTTP; public-domain Journey to the West. Confirmations were synthetic protocol-test inputs, not model reading. No user deployment was used.'
  };
  await writeFile('output/live-source-check.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  if (Object.values(result.checks).some(v => v !== true)) process.exitCode = 1;
} catch (error) {
  const result = { checkedAt: new Date().toISOString(), code: error.code, message: error.message };
  await writeFile('output/live-source-check.json', JSON.stringify(result, null, 2)); console.log(result); process.exitCode = 1;
} finally { library.close(); recovery?.close(); }

