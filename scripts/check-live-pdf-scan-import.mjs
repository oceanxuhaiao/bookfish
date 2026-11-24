/**
 * Real-host acceptance for scanned-PDF rejection.
 *
 * Drives the running Coopanion World panel over its local HTTP API
 * (127.0.0.1:17788) exactly like the panel does: begin an upload, stream
 * 256 KiB chunks, finish, then read transfer_status. The point is that the
 * rejection has to come from the installed extension's worker, not from this
 * repository's sources.
 *
 * Usage: node scripts/check-live-pdf-scan-import.mjs "<pdf path>" "<output json>"
 */
import { openSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const base = 'http://127.0.0.1:17788';
const endpoint = `${base}/api/webui/providers/world%3Abookfish/panels/status/`;
const file = process.argv[2];
const out = process.argv[3] ?? 'output/acceptance-20261125/host-import.json';

async function invoke(method, args = []) {
  const response = await fetch(endpoint + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error(`${method}: ${response.status} ${await response.text()}`);
  return response.json();
}

const booksOf = (state) => (state.books ?? []).map((book) => book.title);
const before = await invoke('get');
const size = statSync(file).size;
const filename = basename(file);
const started = Date.now();
const task = await invoke('upload_begin', [{ kind: 'book', filename, autoMetadata: true, size }]);
let offset = 0;
let chunks = 0;
try {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(task.chunkBytes);
    while (offset < size) {
      const read = readSync(fd, buffer, 0, Math.min(task.chunkBytes, size - offset), offset);
      const ack = await invoke('upload_chunk', [task.id, offset, buffer.subarray(0, read).toString('base64')]);
      if (ack.offset !== offset + read) throw new Error(`offset mismatch at ${offset}`);
      offset = ack.offset;
      chunks += 1;
    }
  } finally {
    closeSync(fd);
  }
  const started2 = Date.now();
  await invoke('upload_finish', [task.id]);
  let status = await invoke('transfer_status', []);
  while (status && status.state === 'processing' && Date.now() - started2 < 120000) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    status = await invoke('transfer_status', []);
  }
  const after = await invoke('get');
  const receipt = {
    file,
    bytes: size,
    chunks,
    uploadMs: started2 - started,
    importMs: Date.now() - started2,
    totalMs: Date.now() - started,
    state: status?.state,
    stage: status?.stage,
    error: status?.error,
    booksBefore: booksOf(before).length,
    booksAfter: booksOf(after).length,
    libraryUnchanged: JSON.stringify(booksOf(before)) === JSON.stringify(booksOf(after)),
    importedTitlePresent: booksOf(after).some((title) => /夜航西飞/.test(title)),
  };
  writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  await invoke('transfer_cancel', [task.id]).catch(() => {});
  throw error;
}
