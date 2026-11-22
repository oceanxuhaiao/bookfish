import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Library } from '../src/library.ts';
const app = process.argv[2];
if (!app) throw new Error('Usage: node --import tsx scripts/verify-writer-lock-host.mts <Coopanion resources/app>');
const root = process.cwd(), scratch = resolve('evidence/writer-lock/host-scratch');
const home = join(scratch, 'home'), deployment = join(home, 'companion'), extensions = join(scratch, 'extensions');
mkdirSync(deployment, { recursive: true }); mkdirSync(join(extensions, 'node_modules'), { recursive: true });
writeFileSync(join(deployment, 'deployment.json'), JSON.stringify({ bot: 'cormini' }));
writeFileSync(join(deployment, 'guide.json'), JSON.stringify({ done: true }));
writeFileSync(join(deployment, 'config.json'), JSON.stringify({ displayName: 'Bookfish lock acceptance', language: 'zh', providerSchemaVersion: 3, activeProvider: '', web: { port: 17992 }, tick: { intervalMinutes: null }, companion: { telemetry: false, autoUpdate: false }, worlds: { 'desktop-pet': { enabled: false }, coopanion: { enabled: false }, bookfish: { enabled: true, automaticReading: false, automaticSharing: false, automaticReview: false, realRoutineEnabled: false, allowNetwork: false, storyMemoryEnabled: true } } }));
writeFileSync(join(extensions, 'package.json'), JSON.stringify({ name: 'isolated-lock-extensions', private: true, dependencies: { 'cortico-world-bookfish': `link:${root.replaceAll('\\', '/')}` } }));
const link = join(extensions, 'node_modules', 'cortico-world-bookfish'); if (!existsSync(link)) symlinkSync(root, link, 'junction');
const data = join(deployment, 'data');
const initial = new Library({ dataDir: data, storyMemoryEnabled: true });
initial.open();
if (!initial.list().length) {
  const book = initial.import({ filename: 'lock-fixture.txt', title: '锁恢复合成短篇', author: '测试', base64: Buffer.from('第一章 海边\n小鱼在海边读书。'.repeat(110)).toString('base64') }).book;
  initial.select(book.key); const task = initial.readNext(); if (task.complete) throw Error('fixture complete');
  initial.finish({ taskId: task.taskId, bookKey: task.bookKey, segmentId: task.segmentId, understanding: '仅用于写锁验收的合成确认。' });
}
const bookKey = initial.list()[0].key;
initial.reflect({ bookKey, requestId: 'lock-host-reflection', episode: { trigger: '小鱼读书', interpretation: '合成写锁测试的足迹，不能视为真实阅读。', evidence: [{ segmentId: 0, quote: '小鱼在海边读书。', start: 7 }] } });
initial.captureStory({ bookKey, requestId: 'lock-host-story', changes: [{ kind: 'event', summary: '小鱼在海边读书（合成测试）', evidenceSegmentIds: [0], sourceKind: 'model_interpretation' }] });
const semantic = () => ({ books: initial.list(), journal: initial.timeline(), story: initial.storyOverview(bookKey), storyStatus: initial.storyStatus() });
const before = semantic(); initial.close();
const log = createWriteStream(resolve('evidence/writer-lock/coopanion-core.log'));
const records: unknown[] = [];
async function launch() {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC']) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, { CORTICO_HOME: home, CORTICO_EXTENSIONS_DIR: extensions, CORTICO_START_PAUSED: '1', COOPANION_VERSION: JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).version, CORTICO_LANGUAGE: 'zh' });
  const child = fork(join(app, 'core', 'boot.ts'), [], { cwd: app, env, execArgv: ['--import', pathToFileURL(join(app, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false });
  const ready = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Core startup timeout')); }, 45000);
    child.on('message', (message: any) => { if (message?.type === 'companion:ready') { clearTimeout(timer); resolve(message); } });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Core exited ${code}/${signal}`)); });
  });
  records.push({ step: 'core-ready', pid: child.pid, ready });
  return { child, base: `http://127.0.0.1:${ready.port}` };
}
async function request(base: string, path: string, body?: unknown) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Origin: base }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const value = await response.json(); records.push({ path, status: response.status, value }); if (!response.ok) throw new Error(JSON.stringify(value)); return value;
}
let running: Awaited<ReturnType<typeof launch>> | undefined;
try {
  running = await launch();
  const worlds = await request(running.base, '/api/worlds') as { worlds: Array<{ id: string; status: string }> };
  if (!worlds.worlds.some(w => w.id === 'bookfish' && w.status === 'active')) throw new Error('Bookfish not active');
  for (const enabled of [false, true, false, true]) await request(running.base, '/api/worlds/activation', { id: 'bookfish', enabled });
  await request(running.base, '/api/worlds/restart', { id: 'bookfish' });
  const exited = once(running.child, 'exit'); running.child.kill('SIGKILL'); records.push({ step: 'forced-core-exit', pid: running.child.pid, termination: await exited }); running = undefined;
  running = await launch(); const restoredWorlds = await request(running.base, '/api/worlds') as { worlds: Array<{ id: string; status: string }> };
  if (!restoredWorlds.worlds.some(w => w.id === 'bookfish' && w.status === 'active')) throw new Error('Bookfish failed crash recovery');
  await request(running.base, '/api/worlds/activation', { id: 'bookfish', enabled: false });
  initial.open(); const after = semantic(); initial.close();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Book / progress / history changed');
  records.push({ step: 'semantic-preservation', before, after, equal: true });
  const stopped = once(running.child, 'exit'); running.child.send({ type: 'companion:shutdown' }); await stopped; running = undefined;
  writeFileSync(resolve('evidence/writer-lock/coopanion-host.json'), JSON.stringify({ os: process.platform, node: process.version, host: JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).version, scope: 'Installed Coopanion Core, isolated synthetic library; no Electron UI or production deployment', records }, null, 2));
} finally {
  if (running) { const exited = once(running.child, 'exit'); running.child.kill('SIGKILL'); await exited; }
  log.end();
}
