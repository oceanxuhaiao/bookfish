/** Managed directory layout and crash-safe JSON persistence. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { RuntimeHealth, RuntimeManifest } from './types.ts';

export interface ActivePointer {
  schema: 1;
  runtimeId: string;
  source: 'managed' | 'legacy';
  /** Path relative to the runtime base; never absolute. */
  path: string;
  manifestDigest: string;
  runtimeVersion: string;
  soNovelVersion: string;
  activatedAt: string;
}

export interface InstallRecord {
  schema: 1;
  installId: string;
  kind: 'online' | 'offline';
  phase: string;
  runtimeId: string;
  bytesReceived: number;
  bytesTotal: number;
  startedAt: string;
  updatedAt: string;
  error: { code: string; message: string; retryable: boolean } | null;
  archivePath?: string;
  health?: RuntimeHealth;
  /** Sanitized diagnostics kept for support, never absolute paths. */
  diagnostic?: string;
}

export interface RuntimeLayout {
  base: string;
  versions: string;
  staging: string;
  downloads: string;
  installs: string;
}

export function runtimeLayout(dataDir: string): RuntimeLayout {
  const base = join(dataDir, 'bookfish', 'novel-engine');
  return { base, versions: join(base, 'versions'), staging: join(base, 'staging'), downloads: join(base, 'downloads'), installs: join(base, 'installs') };
}

export function ensureLayout(layout: RuntimeLayout): void {
  for (const dir of [layout.base, layout.versions, layout.staging, layout.downloads, layout.installs]) mkdirSync(dir, { recursive: true });
}

/** Resolve `relative` under `base`, refusing escapes. */
export function safeJoin(base: string, relative: string): string {
  const root = resolve(base);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) throw new Error('Runtime path escapes the managed directory');
  return target;
}

export function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return undefined; }
}

export function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
}

export function removeIfExists(path: string): void {
  try { if (existsSync(path)) rmSync(path, { recursive: true, force: true }); } catch { /* occupied files are retried on the next cleanup */ }
}

export function manifestMarker(versionDir: string): string {
  return join(versionDir, '.bookfish-runtime.json');
}

export function writeVersionMarker(versionDir: string, manifest: RuntimeManifest): void {
  atomicWriteJson(manifestMarker(versionDir), manifest);
}

export function readVersionMarker(versionDir: string): RuntimeManifest | undefined {
  return readJson<RuntimeManifest>(manifestMarker(versionDir));
}
