import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

/** The default body directory is metadataRoot/books; an empty setting keeps it. */
export function resolveTextStoreDir(metaRoot: string, configured?: string): string {
  const value = typeof configured === 'string' ? configured.trim() : '';
  return value ? resolve(value) : join(metaRoot, 'books');
}

/** Validate and probe a user-supplied absolute directory. Empty means "use the default". */
export function assertWritableTextStoreDir(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Text storage path must be a string');
  const text = value.trim();
  if (!text) return '';
  if (text.length > 500) throw new Error('Text storage path is too long');
  if (text.includes('\0')) throw new Error('Text storage path contains NUL');
  if (!isAbsolute(text)) throw new Error('Text storage path must be absolute');
  const dir = resolve(text);
  try {
    mkdirSync(dir, { recursive: true });
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
    const probe = join(dir, `.bookfish-write-${randomUUID()}.tmp`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
  } catch {
    throw new Error(`Text storage path is not a writable directory: ${dir}`);
  }
  return dir;
}

export function samePath(a: string, b: string): boolean {
  const left = resolve(a), right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function isAbsoluteTextStorePath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return true;
  return isAbsolute(text);
}
