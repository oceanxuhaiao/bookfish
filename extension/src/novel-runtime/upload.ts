/** Chunked, streaming upload session for offline runtime ZIP import. */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const UPLOAD_CHUNK = 1024 * 1024;
const TTL = 30 * 60_000;

interface Session { id: string; file: string; size: number; offset: number; expires: number; filename: string; last?: { offset: number; base64: string } }

export class RuntimeUploads {
  private active?: Session;
  constructor(private readonly dir: string, private readonly maxBytes: number, private readonly now: () => number = Date.now) {}

  private cleanup(file: string): void { try { if (existsSync(file)) unlinkSync(file); } catch { /* best effort */ } }

  private require(id: unknown): Session {
    const session = this.active;
    if (!session || id !== session.id || this.now() > session.expires) {
      if (session && this.now() > session.expires) this.close();
      throw new Error('离线包上传已过期，请重新选择文件');
    }
    session.expires = this.now() + TTL;
    return session;
  }

  begin(input: unknown): { id: string; chunkBytes: number } {
    const value = input as { size?: unknown; filename?: unknown } | undefined;
    const size = value?.size;
    if (!Number.isSafeInteger(size) || (size as number) < 1024 || (size as number) > this.maxBytes) throw new Error('离线运行时包大小超出允许范围');
    const filename = value?.filename;
    if (typeof filename !== 'string' || !/\.zip$/iu.test(filename) || filename.length > 200) throw new Error('请选择 .zip 格式的离线运行时包');
    this.cancel();
    mkdirSync(this.dir, { recursive: true });
    const id = randomUUID();
    const file = join(this.dir, `upload-${id}.part`);
    closeSync(openSync(file, 'wx', 0o600));
    this.active = { id, file, size: size as number, offset: 0, expires: this.now() + TTL, filename };
    return { id, chunkBytes: UPLOAD_CHUNK };
  }

  chunk(id: unknown, offset: unknown, base64: unknown): { offset: number } {
    const session = this.require(id);
    if (typeof base64 !== 'string' || base64.length > Math.ceil(UPLOAD_CHUNK / 3) * 4) throw new Error('上传分块无效');
    if (!Number.isSafeInteger(offset)) throw new Error('上传分块偏移无效');
    if (session.last && session.last.offset === offset && session.last.base64 === base64) return { offset: session.offset };
    if (offset !== session.offset) throw new Error('上传分块顺序不符，请重试');
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > UPLOAD_CHUNK || bytes.toString('base64') !== base64) throw new Error('上传分块编码无效');
    if (session.offset + bytes.length > session.size) throw new Error('上传分块超过声明大小');
    const fd = openSync(session.file, 'r+');
    try {
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, session.offset + written);
    } finally { closeSync(fd); }
    session.last = { offset: session.offset, base64 };
    session.offset += bytes.length;
    return { offset: session.offset };
  }

  finish(id: unknown): { file: string; size: number; filename: string } {
    const session = this.require(id);
    if (session.offset !== session.size) throw new Error('离线包尚未上传完成');
    const fd = openSync(session.file, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (statSync(session.file).size !== session.size) { this.cancel(); throw new Error('离线包写入大小不符'); }
    this.active = undefined;
    return { file: session.file, size: session.size, filename: session.filename };
  }

  cancel(id?: unknown): { cancelled: boolean } {
    const session = this.active;
    if (!session) return { cancelled: false };
    if (id !== undefined && id !== session.id) throw new Error('离线包上传会话不存在');
    this.close();
    return { cancelled: true };
  }

  close(): void {
    const session = this.active;
    this.active = undefined;
    if (session) this.cleanup(session.file);
  }

  status(): { active: boolean; uploaded: number; total: number } {
    if (!this.active || this.now() > this.active.expires) return { active: false, uploaded: 0, total: 0 };
    return { active: true, uploaded: this.active.offset, total: this.active.size };
  }

  /** Remove abandoned part files from a previous process. */
  recover(): void {
    mkdirSync(this.dir, { recursive: true });
    for (const name of readdirSync(this.dir)) {
      if (/^upload-[a-f0-9-]{36}\.part$/u.test(name)) rmSync(join(this.dir, name), { force: true });
    }
  }
}
