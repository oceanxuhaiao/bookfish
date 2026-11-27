import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Remove one variable from the deployment .env and the process environment.
 * Other lines are kept byte-for-byte except for line-ending normalization; the
 * write is atomic and only the owner can read the result. The key value never
 * appears in errors or logs.
 */
export function clearStoredSecret(botDir: string, name: string): boolean {
  if (!ENV_NAME.test(name)) throw new Error('Invalid secret variable name');
  delete process.env[name];
  const file = join(botDir, '.env');
  if (!existsSync(file)) return true;
  const original = readFileSync(file, 'utf8');
  const hadTrailingNewline = /\r?\n$/.test(original);
  const lines = original.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop();
  const kept = lines.filter((line) => !new RegExp(`^[ \\t]*${name}[ \\t]*=`).test(line));
  if (kept.length === lines.length) return true;
  const contents = kept.join('\n') + (hadTrailingNewline || kept.length > 0 ? '\n' : '');
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, contents, { mode: 0o600 });
  try {
    renameSync(temp, file);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
  return true;
}