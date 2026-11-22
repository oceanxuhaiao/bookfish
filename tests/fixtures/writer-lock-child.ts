import { Library } from '../../src/library.ts';
import { inspectProcess } from '../../src/process-identity.ts';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const [dir, mode = 'library'] = process.argv.slice(2);
const library = new Library({ dataDir: dir, storyMemoryEnabled: true });
const marker = join(dir, 'bookfish', 'writer.lock');
process.on('message', message => {
  if (message === 'acquire') acquire();
  if (message === 'close') {
    if (mode === 'legacy') { const saved = JSON.parse(readFileSync(marker, 'utf8')); if (saved.pid === process.pid) unlinkSync(marker); }
    else if (mode !== 'idle') library.close();
    process.send!({ type: 'closed', pid: process.pid }); process.exit(0);
  }
});
function acquire() {
  try {
    if (mode === 'legacy') {
      mkdirSync(join(dir, 'bookfish'), { recursive: true });
      const fd = openSync(marker, 'wx');
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token: randomUUID() })); } finally { closeSync(fd); }
    } else if (mode !== 'idle') library.open();
    process.send!({ type: 'acquired', pid: process.pid, identity: inspectProcess(process.pid) });
  } catch (error) { process.send!({ type: 'denied', pid: process.pid, error: String(error) }); }
}
process.send!({ type: 'ready', pid: process.pid });
