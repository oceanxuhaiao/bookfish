/**
 * Startup self-check for a runtime directory.
 *
 * Two independent facts are reported:
 *  1. the bundled Java and bridge can actually load the engine classes;
 *  2. (separately) a book source host is reachable over the network.
 * A present file is never treated as a working engine.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { RuntimeHealth, RuntimeManifest } from './types.ts';

interface RunResult { stdout: string; stderr: string; code: number | null }

function killTree(child: ChildProcess): void {
  if (!child.pid || child.killed) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* best effort */ }
  } else {
    try { child.kill('SIGKILL'); } catch { /* best effort */ }
  }
}

function run(command: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error('cancelled'));
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const onAbort = (): void => { if (!settled) killTree(child); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { if (!settled) killTree(child); }, options.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < 256 * 1024) stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 256 * 1024) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); reject(new Error(`Cannot start ${command}: ${error.message}`)); });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted) reject(new Error('cancelled'));
      else resolve({ stdout, stderr, code });
    });
  });
}

export function javaBinary(dir: string): string {
  return join(dir, 'runtime', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
}

function parseJavaVersion(output: string): { version: string; major: number } | null {
  const match = output.match(/version "([^"]+)"/u) ?? output.match(/openjdk ([0-9][^\s]*)/u);
  if (!match) return null;
  const version = match[1]!;
  const major = Number(version.split(/[.+-]/u)[0]);
  return Number.isSafeInteger(major) ? { version, major } : null;
}

/** Keep Windows/Unix paths out of user-facing diagnostics. */
function sanitize(message: string): string {
  return message.replace(/[A-Za-z]:\\[^\s"']+/gu, '<path>').replace(/\/(?:[^\s"']+\/)+[^\s"']*/gu, '<path>').slice(0, 200);
}

export interface ProbeOptions {
  bridgeClasses: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Verify Java + bridge + engine classes without touching the network. */
export async function probeRuntime(dir: string, manifest: RuntimeManifest, options: ProbeOptions): Promise<RuntimeHealth> {
  const checkedAt = new Date().toISOString();
  const java = javaBinary(dir);
  if (!existsSync(java)) return { state: 'failed', checkedAt, message: '运行时缺失 Java，需要修复安装' };
  if (!existsSync(join(dir, 'app.jar'))) return { state: 'failed', checkedAt, message: '运行时缺失引擎文件，需要修复安装' };
  if (!existsSync(join(dir, 'rules', 'main.json'))) return { state: 'failed', checkedAt, message: '运行时缺失书源规则，需要修复安装' };
  let version: { version: string; major: number } | null = null;
  try {
    const result = await run(java, ['-version'], { cwd: dir, signal: options.signal, timeoutMs: 30_000 });
    version = parseJavaVersion(`${result.stdout}\n${result.stderr}`);
  } catch (error) {
    if (options.signal?.aborted) return { state: 'failed', checkedAt, message: '自检已取消' };
    return { state: 'failed', checkedAt, message: `无法启动运行时 Java：${sanitize((error as Error).message)}` };
  }
  if (!version) return { state: 'failed', checkedAt, message: '无法识别运行时 Java 版本' };
  if (version.major !== manifest.java.major) return { state: 'failed', checkedAt, message: `Java 版本不符：需要 ${manifest.java.major}，实际 ${version.major}`, javaMajor: version.major };
  let rulesSha256 = '';
  try { rulesSha256 = createHash('sha256').update(readFileSync(join(dir, 'rules', 'main.json'))).digest('hex'); }
  catch { return { state: 'failed', checkedAt, message: '书源规则无法读取', javaMajor: version.major }; }
  if (rulesSha256 !== manifest.rules.sha256) return { state: 'failed', checkedAt, message: '书源规则摘要不符，需要修复安装', javaMajor: version.major };
  const separator = process.platform === 'win32' ? ';' : ':';
  const classpath = `${join(dir, 'app.jar')}${separator}${options.bridgeClasses}`;
  let payload: { protocol?: number; ok?: boolean; soNovelVersion?: string; rulesSources?: number; checks?: Record<string, unknown> } = {};
  try {
    const result = await run(java, ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', `-Dbookfish.soNovelVersion=${manifest.soNovelVersion}`, '-cp', classpath, 'SonovelBridge', 'health', join(dir, 'rules', 'main.json')], {
      cwd: dir, signal: options.signal, timeoutMs: options.timeoutMs ?? 60_000,
    });
    const marker = result.stdout.indexOf('SONOVEL_HEALTH=');
    if (marker < 0) {
      const detail = (result.stderr || result.stdout).split(/\r?\n/u).filter(Boolean).slice(-2).join(' | ').slice(0, 240);
      return { state: 'failed', checkedAt, message: `桥接自检没有返回结果${detail ? `：${detail}` : ''}`, javaMajor: version.major };
    }
    payload = JSON.parse(result.stdout.slice(marker + 'SONOVEL_HEALTH='.length).trim()) as typeof payload;
  } catch (error) {
    if (options.signal?.aborted) return { state: 'failed', checkedAt, message: '自检已取消', javaMajor: version.major };
    return { state: 'failed', checkedAt, message: `桥接自检失败：${sanitize((error as Error).message)}`, javaMajor: version.major };
  }
  if (payload.protocol !== manifest.bridgeProtocol) return { state: 'failed', checkedAt, message: `桥接协议不符：需要 ${manifest.bridgeProtocol}，实际 ${payload.protocol ?? 'unknown'}`, javaMajor: version.major };
  if (payload.ok !== true) return { state: 'failed', checkedAt, message: '引擎类加载失败', javaMajor: version.major };
  if (payload.soNovelVersion && payload.soNovelVersion !== manifest.soNovelVersion) return { state: 'failed', checkedAt, message: '引擎版本与清单不符', javaMajor: version.major };
  if (payload.rulesSources !== manifest.rules.sources) return { state: 'failed', checkedAt, message: '书源数量与清单不符', javaMajor: version.major };
  return {
    state: 'ok', checkedAt, bridgeProtocol: payload.protocol, javaMajor: version.major,
    soNovelVersion: payload.soNovelVersion ?? manifest.soNovelVersion, rulesSha256,
    message: `Java ${version.version} · 引擎 ${manifest.soNovelVersion} · ${manifest.rules.sources} 个书源`,
  };
}

/** Network reachability of one book source, kept separate from engine health. */
export async function checkSourceReachability(host: string, signal?: AbortSignal, timeoutMs = 12_000): Promise<{ ok: boolean; message: string }> {
  if (!/^[a-z0-9.-]+$/iu.test(host)) return { ok: false, message: '书源地址无效' };
  return await new Promise((resolve) => {
    const req = httpsRequest({ host, port: 443, path: '/', method: 'HEAD', timeout: timeoutMs, headers: { 'user-agent': 'bookfish-source-check' } }, (response: IncomingMessage) => {
      response.resume();
      resolve({ ok: true, message: `书源站点可连接（HTTP ${response.statusCode ?? 0}）` });
    });
    const finish = (message: string): void => resolve({ ok: false, message });
    req.on('timeout', () => { req.destroy(); finish('书源站点连接超时'); });
    req.on('error', (error: Error) => finish(`书源站点无法连接：${error.message.slice(0, 160)}`));
    const onAbort = (): void => { req.destroy(); finish('检测已取消'); };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    req.end();
  });
}
