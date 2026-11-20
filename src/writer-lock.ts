import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync as Database } from 'node:sqlite';
import { inspectProcess, inspectSelf, type ProcessInspection } from './process-identity.ts';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const PROTOCOL = 'bookfish-sqlite-writer-v1';
interface Marker { pid: number; token: string; protocol?: string; processIdentity?: string }
interface Snapshot { raw: string; marker: Marker; time: number }
export interface WriterLockOptions {
  inspect?: (pid: number) => ProcessInspection;
  self?: () => ProcessInspection;
}

/** The dedicated SQLite write transaction owns the entire business-resource lifetime. */
export class WriterLock {
  readonly file: string;
  readonly markerFile: string;
  private db?: Database;
  private token?: string;
  constructor(dir: string, private readonly options: WriterLockOptions = {}) {
    this.file = join(dir, 'writer-lock.sqlite');
    this.markerFile = join(dir, 'writer.lock');
  }
  private failure(reason: string, pid?: number): Error {
    return new Error(`Bookfish 书库写锁：${reason}${pid ? `（PID ${pid}）` : ''}。锁文件：${this.file}；兼容标记：${this.markerFile}。请先关闭使用此书库的其他 Bookfish / Coopanion 实例后重试。若进程身份无法确认，请在任务管理器中核对进程和启动时间；必要时退出全部相关实例并备份书库，再检查或移走 writer.lock。不要删除 SQLite 锁数据库或书库数据。`);
  }
  private snapshot(): Snapshot | undefined {
    try {
      const stat = lstatSync(this.markerFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw this.failure('兼容标记不是有效的普通锁文件，无法确认旧写入者');
      const raw = readFileSync(this.markerFile, 'utf8');
      let marker: Marker;
      try { marker = JSON.parse(raw); } catch { throw this.failure('旧锁 JSON 损坏，无法确认旧写入者'); }
      if (!marker || !Number.isSafeInteger(marker.pid) || marker.pid <= 0 || typeof marker.token !== 'string' || !marker.token || (marker.processIdentity !== undefined && typeof marker.processIdentity !== 'string')) throw this.failure('旧锁缺少有效 PID、Token 或进程创建身份');
      return { raw, marker, time: Math.min(stat.mtimeMs, stat.birthtimeMs || stat.mtimeMs) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof Error && error.message.startsWith('Bookfish 书库写锁')) throw error;
      throw this.failure('无法读取兼容标记，可能是文件权限不足或被占用，无法确认旧写入者');
    }
  }
  private remove(saved: Snapshot): void {
    const current = this.snapshot();
    if (!current || current.raw !== saved.raw || current.marker.token !== saved.marker.token) throw this.failure('兼容标记在检查期间发生变化，已停止接管', current?.marker.pid);
    unlinkSync(this.markerFile);
  }
  acquire(): void {
    if (this.db) throw this.failure('此写锁对象尚未释放');
    let db: Database | undefined;
    try {
      db = new DatabaseSync(this.file);
      db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    } catch (error) {
      try { db?.close(); } catch { /* no business resource has been opened */ }
      const busy = ((error as { errcode?: number }).errcode ?? 0) & 255;
      let pid: number | undefined;
      try { pid = this.snapshot()?.marker.pid; } catch { /* SQLite remains authoritative */ }
      throw this.failure(busy === 5 || busy === 6 ? '存在另一个书库写入者，书库已占用（already open）' : '无法打开独立锁数据库，请检查目录写入权限、磁盘和文件状态', pid);
    }
    this.db = db;
    try {
      const previous = this.snapshot();
      if (previous) {
        const marker = previous.marker;
        // A v1 marker is only a downgrade fence. Successful BEGIN proves no v1 writer owns it.
        if (marker.protocol !== PROTOCOL) {
          const result = (this.options.inspect ?? inspectProcess)(marker.pid);
          if (result.kind === 'unknown') throw this.failure(`旧锁进程身份无法确认：${result.reason}`, marker.pid);
          if (result.kind === 'running') {
            if (marker.processIdentity) {
              if (marker.processIdentity === result.process.identity) throw this.failure('存在仍存活的旧版书库写入者，禁止接管', marker.pid);
            } else if (result.process.startedAtMs <= previous.time + 2000) {
              throw this.failure('旧版锁没有进程创建身份；该进程在锁文件产生前已启动或处于时间误差范围，不能确认已退出，禁止接管', marker.pid);
            }
          }
        }
        this.remove(previous);
      }
      const identity = (this.options.self ?? inspectSelf)();
      const token = randomUUID();
      const fd = openSync(this.markerFile, 'wx');
      this.token = token;
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token, protocol: PROTOCOL,
          ...(identity.kind === 'running' ? { processIdentity: identity.process.identity } : {}) }));
        fsyncSync(fd);
      } finally { closeSync(fd); }
    } catch (error) {
      try { this.release(); } catch { /* retain original acquisition failure */ }
      if (error instanceof Error && error.message.startsWith('Bookfish 书库写锁')) throw error;
      throw this.failure('创建或迁移兼容标记失败，可能被其他实例抢先创建或目录不可写');
    }
  }
  release(): void {
    if (!this.db) return;
    const errors: Error[] = [];
    if (this.token) {
      try {
        const saved = this.snapshot();
        if (saved && saved.marker.token === this.token) this.remove(saved);
        else if (saved) throw this.failure('兼容标记 Token 已变化，保留该文件供检查', saved.marker.pid);
      } catch { errors.push(this.failure('兼容标记无法安全删除，已保留文件供检查')); }
      this.token = undefined;
    }
    try { this.db.exec('ROLLBACK'); } catch { errors.push(this.failure('锁事务回滚失败，正在关闭锁连接')); }
    try { this.db.close(); this.db = undefined; } catch { errors.push(this.failure('锁连接关闭失败，请退出当前实例后重试')); }
    if (errors.length) throw new AggregateError(errors, errors.map(e => e.message).join('\n'));
  }
}
