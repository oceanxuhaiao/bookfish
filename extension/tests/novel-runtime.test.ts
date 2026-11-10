import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { isSafeRelativePath, parseRuntimeManifest, payloadManifestMatches } from '../src/novel-runtime/manifest.ts';
import { extractRuntimeZip, verifyExtractedPayload } from '../src/novel-runtime/archive.ts';
import { createRuntimeFixture } from './helpers/runtime-fixture.ts';
import type { TrustedRuntimeManifest } from '../src/novel-runtime/types.ts';

const roots: string[] = [];
function temp(): string { const dir = mkdtempSync(join(tmpdir(), 'bookfish-runtime-')); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface RawEntry { name: string; data: Buffer; mode?: number; compress?: boolean }
function rawZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.compress ? deflateRawSync(entry.data) : entry.data;
    const method = entry.compress ? 8 : 0;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(central, name); offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}
function writeRaw(dir: string, name: string, entries: RawEntry[]): string { const file = join(dir, name); writeFileSync(file, rawZip(entries)); return file; }

describe('runtime manifest safety', () => {
  it('rejects traversal, absolute, ADS and device paths', () => {
    for (const path of ['../x', '/abs', 'C:/x', 'a\\b', 'a:b', 'CON', 'dir/./x', 'dir/x.', 'dir/x ']) expect(isSafeRelativePath(path), path).toBe(false);
    for (const path of ['app.jar', 'runtime/bin/java.exe', 'rules/main.json']) expect(isSafeRelativePath(path), path).toBe(true);
  });

  it('rejects duplicate paths and mismatched payload sizes', async () => {
    const dir = temp();
    const fixture = await createRuntimeFixture(dir);
    const payload = { ...fixture.manifest } as Record<string, unknown>;
    delete payload.archive;
    expect(parseRuntimeManifest(payload).runtimeId).toBe(fixture.manifest.runtimeId);
    const duplicate = { ...payload, files: [...(payload.files as unknown[]), (payload.files as Array<{ path: string }>)[0]] };
    expect(() => parseRuntimeManifest(duplicate)).toThrow(/Duplicate/);
    expect(() => parseRuntimeManifest({ ...payload, payloadBytes: 1 })).toThrow(/size mismatch/);
  });

  it('compares the in-archive manifest while ignoring only its archive digest', async () => {
    const dir = temp();
    const fixture = await createRuntimeFixture(dir);
    const inner = { ...fixture.manifest } as unknown as Record<string, unknown>;
    delete inner.archive;
    expect(payloadManifestMatches(inner as unknown as TrustedRuntimeManifest, fixture.manifest)).toBe(true);
    expect(payloadManifestMatches({ ...inner, runtimeVersion: 'other' } as unknown as TrustedRuntimeManifest, fixture.manifest)).toBe(false);
  });
});

describe('safe extraction worker', () => {
  it('extracts a real fixture and verifies every file digest', async () => {
    const dir = temp();
    const fixture = await createRuntimeFixture(dir);
    const out = join(dir, 'out');
    const result = await extractRuntimeZip(fixture.zipPath, out);
    expect(result.files.length).toBe(fixture.manifest.payloadFiles + 1);
    await verifyExtractedPayload(out, fixture.manifest);
  });

  it('refuses path traversal entries', async () => {
    const dir = temp();
    const zip = writeRaw(dir, 'traversal.zip', [{ name: '../escape.txt', data: Buffer.from('x') }]);
    await expect(extractRuntimeZip(zip, join(dir, 'out'))).rejects.toBeTruthy();
    expect(await import('node:fs').then(({ existsSync }) => existsSync(join(dir, 'escape.txt')))).toBe(false);
  });

  it('refuses absolute paths and NTFS streams', async () => {
    const dir = temp();
    for (const [name, entry] of [['absolute.zip', '/abs.txt'], ['ads.zip', 'file.txt:secret']] as const) {
      const zip = writeRaw(dir, name, [{ name: entry, data: Buffer.from('x') }]);
      await expect(extractRuntimeZip(zip, join(dir, 'out'))).rejects.toBeTruthy();
    }
    expect(await import('node:fs').then(({ existsSync }) => existsSync(join(dir, 'abs.txt')))).toBe(false);
  });

  it('refuses case-insensitive duplicate names', async () => {
    const dir = temp();
    const zip = writeRaw(dir, 'dup.zip', [{ name: 'a.txt', data: Buffer.from('1') }, { name: 'A.TXT', data: Buffer.from('2') }]);
    await expect(extractRuntimeZip(zip, join(dir, 'out'))).rejects.toMatchObject({ code: 'zip_duplicate' });
  });

  it('refuses symlinks and Windows device names', async () => {
    const dir = temp();
    const link = writeRaw(dir, 'link.zip', [{ name: 'link', data: Buffer.from('../outside'), mode: 0o120777 }]);
    await expect(extractRuntimeZip(link, join(dir, 'out'))).rejects.toMatchObject({ code: 'zip_symlink' });
    const device = writeRaw(dir, 'device.zip', [{ name: 'NUL.txt', data: Buffer.from('x') }]);
    await expect(extractRuntimeZip(device, join(dir, 'out2'))).rejects.toMatchObject({ code: 'zip_entry_name' });
  });

  it('refuses a high-ratio decompression bomb', async () => {
    const dir = temp();
    const zip = writeRaw(dir, 'bomb-ratio.zip', [{ name: 'big.bin', data: Buffer.alloc(2 * 1024 * 1024, 0), compress: true }]);
    await expect(extractRuntimeZip(zip, join(dir, 'out'))).rejects.toMatchObject({ code: 'zip_bomb' });
  });

  it('cleans nothing outside the staging directory when rejecting a bomb', async () => {
    const dir = temp();
    const marker = join(dir, 'outside.txt');
    mkdirSync(dir, { recursive: true }); writeFileSync(marker, 'keep');
    const zip = writeRaw(dir, 'bomb.zip', [{ name: '../outside.txt', data: Buffer.from('overwrite') }]);
    await expect(extractRuntimeZip(zip, join(dir, 'out'))).rejects.toBeTruthy();
    expect(await import('node:fs').then(({ readFileSync }) => readFileSync(marker, 'utf8'))).toBe('keep');
  });
});
