/** One fresh process per measurement; caller runs each baseline/size at least five times. */
import { mkdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const [sourceArg, fileArg, runArg] = process.argv.slice(2);
if (!sourceArg || !fileArg || !runArg) throw Error('Usage: sourceRoot identicalFixture runId');
const { prepareFileBestEffort } = await import(pathToFileURL(join(resolve(sourceArg), 'src/stream-import.ts')).href);
const { Library } = await import(pathToFileURL(join(resolve(sourceArg), 'src/library.ts')).href);
const file = resolve(fileArg), output = resolve('_verify/round3-performance', runArg); mkdirSync(output, { recursive: true });
const io = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile','-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.pid}') | Select-Object ReadTransferCount,WriteTransferCount | ConvertTo-Json -Compress`], {encoding:'utf8',windowsHide:true}));
const library=new Library({dataDir:output});library.open();
const before = io(); const start = performance.now(); const decoded = prepareFileBestEffort(file); const decodeMs = performance.now() - start;
const added = library.importFileBestEffort({filename:'synthetic.txt',title:'Synthetic '+statSync(file).size/(1024*1024)+'MiB'},file,{decoded});
const fullMs=performance.now()-start,after=io();library.close();
if(added.book.confirmedChars!==0)throw Error('Import changed reading progress');
console.log(JSON.stringify({node:process.version,source:resolve(sourceArg),run:runArg,bytes:statSync(file).size,decodeMs,fullMs,scope:'decode through Library persisted shelf commit, excluding network and retained-original snapshot verification',peakRss:process.resourceUsage().maxRSS*1024,readBytes:Number(after.ReadTransferCount)-Number(before.ReadTransferCount),writeBytes:Number(after.WriteTransferCount)-Number(before.WriteTransferCount),ioMethod:'Win32_Process process I/O transfer counters; includes metadata/pipe I/O, not physical-disk-only',textChars:decoded.metrics.totalChars,bookKey:added.book.key,confirmedChars:added.book.confirmedChars}));
