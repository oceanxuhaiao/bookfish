import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type ProcessIdentity = { identity: string; startedAtMs: number };
export type ProcessInspection = { kind: 'running'; process: ProcessIdentity } | { kind: 'absent' } | { kind: 'unknown'; reason: string };

/** OS creation identity, never a process name or kill(pid, 0) liveness guess. */
export function inspectProcess(pid: number, query: typeof execFileSync = execFileSync): ProcessInspection {
  try {
    if (process.platform === 'win32') {
      const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -eq $p) { 'absent' } else { $d=$p.CreationDate.ToUniversalTime(); $d.Ticks.ToString() + ',' + ([DateTimeOffset]$d).ToUnixTimeMilliseconds().ToString() }`;
      const result = query('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (result === 'absent') return { kind: 'absent' };
      const match = /^(\d+),(\d+)$/.exec(result);
      if (!match) return { kind: 'unknown', reason: 'Windows 未返回可核验的进程创建时间' };
      return { kind: 'running', process: { identity: `win32:${match[1]}`, startedAtMs: Number(match[2]) } };
    }
    if (process.platform === 'linux') {
      let stat: string;
      try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
        throw error;
      }
      const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const seconds = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1];
      const hz = Number(query('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 3000 }));
      if (!ticks || !seconds || !hz) return { kind: 'unknown', reason: '无法读取 Linux 进程创建时间' };
      return { kind: 'running', process: { identity: `linux:${boot}:${ticks}`, startedAtMs: Number(seconds) * 1000 + Number(ticks) * 1000 / hz } };
    }
    return { kind: 'unknown', reason: `当前平台 ${process.platform} 尚不支持进程创建身份核验` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { kind: 'unknown', reason: code === 'EPERM' || code === 'EACCES' ? '当前账户无权查询进程创建时间' : '系统进程信息查询失败或超时，无法确认锁的主人' };
  }
}

let self: ProcessInspection | undefined;
export function inspectSelf(): ProcessInspection {
  if (self) return self;
  const result = inspectProcess(process.pid);
  if (result.kind === 'running') self = result;
  return result;
}
