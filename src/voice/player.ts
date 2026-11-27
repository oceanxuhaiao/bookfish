import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from 'node:process';
import { AudioPlaybackError, safeMessage } from './errors.ts';
import { isWav } from './tts.ts';

const KILL_GRACE_MS = 3000;

/** Absolute system PowerShell path; no PATH lookup, so a planted executable cannot win. */
export function powershellPath(): string {
  const root = env.SystemRoot || 'C:\\Windows';
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/** Escape a single-quoted PowerShell string literal. */
export function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface PlayOptions {
  tempDir: string;
  signal?: AbortSignal;
  /** Test hooks only. */
  spawnImpl?: typeof spawn;
  psExe?: string;
}

export interface PlayResult {
  /** True when the abort signal stopped playback before it finished. */
  aborted: boolean;
}

/**
 * Play one WAV through the Windows built-in SoundPlayer, synchronously.
 * Resolves only after the child process exits and the temp file is removed.
 * Abort kills the process and waits (bounded) for it to disappear.
 */
export async function playWav(bytes: Uint8Array, options: PlayOptions): Promise<PlayResult> {
  if (!isWav(bytes)) throw new AudioPlaybackError('播放器收到无效 WAV 音频');
  const spawnImpl = options.spawnImpl ?? spawn;
  const psExe = options.psExe ?? powershellPath();
  if (!options.spawnImpl && !existsSync(psExe)) throw new AudioPlaybackError('找不到 Windows PowerShell，无法播放语音');

  mkdirSync(options.tempDir, { recursive: true });
  const file = join(options.tempDir, `${randomUUID()}.wav`);
  try {
    writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    throw new AudioPlaybackError(`无法写入临时音频：${safeMessage(error, 200)}`);
  }

  let child: ChildProcess;
  try {
    child = spawnImpl(psExe, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      `$ErrorActionPreference='Stop'; $p = New-Object System.Media.SoundPlayer(${psSingleQuote(file)}); try { $p.PlaySync() } finally { $p.Dispose() }`,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  } catch (error) {
    try { unlinkSync(file); } catch { /* leave for sweep */ }
    throw new AudioPlaybackError(`无法启动系统播放器：${safeMessage(error, 200)}`);
  }

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    if (stderr.length < 2000) stderr += chunk.toString();
  });

  let aborted = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let settleOutcome: ((value: { code: number | null; error?: Error }) => void) | undefined;
  const outcomePromise = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    settleOutcome = resolve;
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code) => resolve({ code }));
  });
  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    try { child.kill(); } catch { /* already gone */ }
    // If the process ignores a normal kill, force it after a short grace period.
    killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, KILL_GRACE_MS);
    killTimer.unref?.();
    // Never leave the caller (or the host shutdown) waiting on a wedged child.
    hardTimer = setTimeout(() => settleOutcome?.({ code: null }), KILL_GRACE_MS + 2000);
    hardTimer.unref?.();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  try {
    const outcome = await outcomePromise;
    if (outcome.error) throw new AudioPlaybackError(`系统播放器启动失败：${safeMessage(outcome.error, 200)}`);
    if (aborted || options.signal?.aborted) return { aborted: true };
    if (outcome.code !== 0) {
      const detail = safeMessage(new Error(stderr.replace(/[\r\n]+/g, ' ').trim()), 200);
      throw new AudioPlaybackError(`系统播放器退出码 ${outcome.code ?? 'unknown'}${detail ? `：${detail}` : ''}`);
    }
    return { aborted: false };
  } finally {
    if (killTimer) clearTimeout(killTimer);
    if (hardTimer) clearTimeout(hardTimer);
    options.signal?.removeEventListener('abort', onAbort);
    if (existsSync(file)) { try { unlinkSync(file); } catch { /* next sweep */ } }
  }
}

/** Remove leftover WAV temp files. Locked files are left for the next sweep. */
export function sweepTempDir(tempDir: string): void {
  try {
    if (!existsSync(tempDir)) return;
    for (const name of readdirSync(tempDir)) {
      if (!name.toLowerCase().endsWith('.wav')) continue;
      try { unlinkSync(join(tempDir, name)); } catch { /* locked or already gone */ }
    }
  } catch { /* directory unavailable */ }
}