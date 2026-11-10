/**
 * Manifest parsing and integrity helpers.
 *
 * Everything here treats manifest content as untrusted until it matches the
 * digest pinned in the extension. Hash comparison is byte-for-byte on the
 * whole payload, never a prefix.
 */
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import type { RuntimeFileEntry, RuntimeManifest, TrustedRuntimeManifest } from './types.ts';

const SHA256 = /^[a-f0-9]{64}$/u;
const RUNTIME_ID = /^[a-z0-9][a-z0-9.-]{2,80}$/u;

/** Stable JSON with sorted object keys, used to compare manifests. */
export function canonicalJson(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input as Record<string, unknown>).sort()
        .map((key) => [key, walk((input as Record<string, unknown>)[key])]));
    }
    return input;
  };
  return JSON.stringify(walk(value));
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Reject anything that could escape the extraction root on any platform. */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.length > 260) return false;
  if (path.includes('\\') || path.includes('\0')) return false;
  if (path.startsWith('/')) return false;
  if (/^[a-zA-Z]:/u.test(path)) return false;
  const segments = path.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return false;
    if (segment.endsWith('.') || segment.endsWith(' ')) return false;
    if (/[<>:"|?*\u0000-\u001f]/u.test(segment)) return false;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu.test(segment)) return false;
  }
  return true;
}

function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error('Invalid runtime manifest number');
  return value as number;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new Error('Invalid runtime manifest text');
  return value;
}

function parseFile(value: unknown): RuntimeFileEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid runtime file entry');
  const record = value as Record<string, unknown>;
  const path = text(record.path, 260);
  if (!isSafeRelativePath(path)) throw new Error('Unsafe runtime file path');
  if (typeof record.sha256 !== 'string' || !SHA256.test(record.sha256)) throw new Error('Invalid runtime file digest');
  return { path, size: integer(record.size, 0, 512 * 1024 * 1024), sha256: record.sha256 };
}

/** Strict parse of an (untrusted) runtime manifest. */
export function parseRuntimeManifest(value: unknown): RuntimeManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid runtime manifest');
  const record = value as Record<string, unknown>;
  if (record.schema !== 1) throw new Error('Unsupported runtime manifest schema');
  const runtimeId = text(record.runtimeId, 80);
  if (!RUNTIME_ID.test(runtimeId)) throw new Error('Invalid runtime id');
  const platform = text(record.platform, 20);
  const arch = text(record.arch, 20);
  if (platform !== 'win32' || arch !== 'x64') throw new Error('Unsupported runtime platform');
  const bridgeProtocol = integer(record.bridgeProtocol, 1, 999);
  const extensionApi = integer(record.extensionApi, 1, 999);
  const java = record.java;
  if (!java || typeof java !== 'object' || Array.isArray(java)) throw new Error('Invalid Java metadata');
  const javaRecord = java as Record<string, unknown>;
  const rules = record.rules;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new Error('Invalid rule metadata');
  const rulesRecord = rules as Record<string, unknown>;
  const rulesPath = text(rulesRecord.path, 260);
  if (!isSafeRelativePath(rulesPath) || typeof rulesRecord.sha256 !== 'string' || !SHA256.test(rulesRecord.sha256)) throw new Error('Invalid rule digest');
  if (!Array.isArray(record.files) || !record.files.length || record.files.length > 20_000) throw new Error('Invalid runtime file list');
  const files = record.files.map(parseFile);
  // Windows is case-insensitive: two entries differing only in case could
  // overwrite each other or make verification order-dependent.
  const seen = new Set<string>();
  let payloadBytes = 0;
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate runtime file path');
    seen.add(key);
    payloadBytes += file.size;
  }
  if (payloadBytes !== integer(record.payloadBytes, 0, 64 * 1024 * 1024 * 1024)) throw new Error('Runtime payload size mismatch');
  if (files.length !== integer(record.payloadFiles, 0, 20_000)) throw new Error('Runtime payload file count mismatch');
  const source = record.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid runtime source metadata');
  const sourceRecord = source as Record<string, unknown>;
  const manifest: RuntimeManifest = {
    schema: 1, runtimeId, runtimeVersion: text(record.runtimeVersion, 40), platform: 'win32', arch: 'x64',
    soNovelVersion: text(record.soNovelVersion, 40), bridgeProtocol, extensionApi,
    java: { vendor: text(javaRecord.vendor, 80), version: text(javaRecord.version, 40), major: integer(javaRecord.major, 8, 99) },
    rules: { path: rulesPath, sha256: rulesRecord.sha256, sources: integer(rulesRecord.sources, 1, 10_000) },
    payloadBytes, payloadFiles: files.length, files,
    createdAt: text(record.createdAt, 40),
    source: { url: text(sourceRecord.url, 500), ...(typeof sourceRecord.commit === 'string' ? { commit: sourceRecord.commit.slice(0, 80) } : {}), ...(typeof sourceRecord.note === 'string' ? { note: sourceRecord.note.slice(0, 500) } : {}) },
  };
  if (record.archive !== undefined) {
    const archive = record.archive;
    if (!archive || typeof archive !== 'object' || Array.isArray(archive)) throw new Error('Invalid archive metadata');
    const archiveRecord = archive as Record<string, unknown>;
    const archivePath = text(archiveRecord.path, 200);
    if (!isSafeRelativePath(archivePath) || !/\.zip$/iu.test(archivePath)) throw new Error('Invalid archive path');
    if (typeof archiveRecord.sha256 !== 'string' || !SHA256.test(archiveRecord.sha256)) throw new Error('Invalid archive digest');
    manifest.archive = { path: archivePath, size: integer(archiveRecord.size, 1, 2 * 1024 * 1024 * 1024), sha256: archiveRecord.sha256 };
  }
  return manifest;
}

export function requireTrustedManifest(value: unknown): TrustedRuntimeManifest {
  const manifest = parseRuntimeManifest(value);
  if (!manifest.archive) throw new Error('Trusted runtime manifest has no archive digest');
  return manifest as TrustedRuntimeManifest;
}

/** Compare the in-archive manifest with the pinned manifest, ignoring only its own archive digest. */
export function payloadManifestMatches(inner: RuntimeManifest, trusted: TrustedRuntimeManifest): boolean {
  const { archive: _ignored, ...innerPayload } = inner;
  const { archive: _trusted, ...trustedPayload } = trusted;
  return canonicalJson(innerPayload) === canonicalJson(trustedPayload);
}

export function findFile(manifest: RuntimeManifest, path: string): RuntimeFileEntry | undefined {
  return manifest.files.find((file) => file.path === path);
}

/**
 * Validate the declared archive size and digest. A mismatch is the expected
 * outcome for a corrupted download or a tampered offline ZIP.
 */
export async function verifyArchive(path: string, manifest: TrustedRuntimeManifest): Promise<{ size: number; sha256: string }> {
  const { size } = statSync(path);
  if (size !== manifest.archive.size) throw new Error(`Runtime archive size mismatch: expected ${manifest.archive.size}, received ${size}`);
  const sha256 = await sha256File(path);
  if (sha256 !== manifest.archive.sha256) throw new Error('Runtime archive SHA-256 mismatch');
  return { size, sha256 };
}
