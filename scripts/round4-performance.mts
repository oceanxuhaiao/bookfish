/** Same input/runtime for both versions; one process and fresh shelf per sample. */
import { createReadStream, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const [sourceArg, fileArg, runArg] = process.argv.slice(2);
if (!sourceArg || !fileArg || !runArg) throw Error('Usage: sourceRoot identicalFixture runId');
const source = resolve(sourceArg), file = resolve(fileArg);
const { prepareFileBestEffort } = await import(pathToFileURL(join(source, 'src/stream-import.ts')).href);
const { Library } = await import(pathToFileURL(join(source, 'src/library.ts')).href);
const digest = createHash('sha256');
for await (const chunk of createReadStream(file)) digest.update(chunk);
const expected = { sha256: digest.digest('hex'), bytes: statSync(file).size };
const output = resolve('_verify/round4-performance', runArg); mkdirSync(output, { recursive: true });
const io = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile','-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.pid}') | Select-Object ReadTransferCount,WriteTransferCount | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true }));
const library = new Library({ dataDir: output }); library.open();
try {
  const before = io(), start = performance.now();
  // Historical implementation ignores the additional argument. Current code authenticates consumed bytes.
  const decoded = prepareFileBestEffort(file, undefined, undefined, undefined, expected);
  const decodeMs = performance.now() - start;
  const added = library.importFileBestEffort({ filename:'synthetic.txt', title:'Synthetic '+expected.bytes }, file, { decoded });
  const fullMs = performance.now() - start, after = io();
  if (added.book.confirmedChars !== 0) throw Error('Import changed reading progress');
  console.log(JSON.stringify({ node:process.version, source, run:runArg, ...expected, decodeMs, fullMs,
    peakRss:process.resourceUsage().maxRSS*1024,
    readBytes:Number(after.ReadTransferCount)-Number(before.ReadTransferCount),
    writeBytes:Number(after.WriteTransferCount)-Number(before.WriteTransferCount),
    ioMethod:'Win32_Process transfer counters, includes metadata/pipe I/O; not physical disk I/O',
    scope:'authenticated decode through persisted shelf; excludes network and original snapshot copy; input hash preflight outside timer',
    textChars:decoded.metrics.totalChars, confirmedChars:added.book.confirmedChars }));
} finally { library.close(); }
