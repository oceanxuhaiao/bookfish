/**
 * Runtime distribution types shared by the manager, the panel and the tests.
 *
 * A runtime package is one ZIP that contains a fixed Java runtime, the pinned
 * so-novel engine and the rule snapshot. The extension carries only a small
 * trusted manifest (hash + size); the archive itself is never bundled.
 */

/** First release supports exactly one platform combination. */
export const SUPPORTED_PLATFORM = { platform: 'win32', arch: 'x64' } as const;
export type SupportedPlatform = typeof SUPPORTED_PLATFORM;

export const BRIDGE_PROTOCOL = 1;

export interface RuntimeFileEntry {
  /** POSIX-style path inside the package; never absolute, never `..`. */
  path: string;
  size: number;
  sha256: string;
}

export interface RuntimeManifest {
  schema: 1;
  runtimeId: string;
  runtimeVersion: string;
  platform: 'win32';
  arch: 'x64';
  soNovelVersion: string;
  bridgeProtocol: number;
  /** World contract version this runtime was validated against. */
  extensionApi: number;
  java: { vendor: string; version: string; major: number };
  rules: { path: string; sha256: string; sources: number };
  /** Sum of `files[].size`. */
  payloadBytes: number;
  payloadFiles: number;
  files: RuntimeFileEntry[];
  /** Empty in the in-archive copy (a ZIP cannot contain its own digest). */
  archive?: { path: string; size: number; sha256: string };
  createdAt: string;
  source: { url: string; commit?: string; note?: string };
}

/** A verified, trusted manifest. `archive` is always present. */
export type TrustedRuntimeManifest = RuntimeManifest & {
  archive: { path: string; size: number; sha256: string };
};

export interface RuntimeHealth {
  state: 'ok' | 'failed' | 'unknown';
  checkedAt: string | null;
  bridgeProtocol?: number;
  javaMajor?: number;
  soNovelVersion?: string;
  rulesSha256?: string;
  /** Short, sanitized Chinese-facing reason. Never contains local paths. */
  message?: string;
  details?: Record<string, string | number | boolean>;
}

export type InstallPhase =
  | 'idle'
  | 'preparing'
  | 'downloading'
  | 'uploading'
  | 'verifying'
  | 'extracting'
  | 'probing'
  | 'waiting_idle'
  | 'activating'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface RuntimeErrorView {
  code: string;
  message: string;
  retryable: boolean;
}

export interface RuntimeInstallView {
  installId: string;
  kind: 'online' | 'offline';
  phase: InstallPhase;
  runtimeId: string;
  bytesReceived: number;
  bytesTotal: number;
  /** 0..100 only when it is a real measurement; null for step-only phases. */
  percent: number | null;
  speedBytesPerSecond: number | null;
  startedAt: string;
  updatedAt: string;
  error: RuntimeErrorView | null;
}

export interface RuntimeVersionView {
  runtimeId: string;
  runtimeVersion: string;
  soNovelVersion: string;
  platform: string;
  source: 'managed' | 'legacy';
  active: boolean;
}

export interface RuntimeStatusView {
  platform: { platform: string; arch: string; supported: boolean };
  installed: boolean;
  usable: boolean;
  runtimeId: string | null;
  runtimeVersion: string | null;
  soNovelVersion: string | null;
  javaVersion: string | null;
  source: 'managed' | 'legacy' | null;
  health: RuntimeHealth;
  install: RuntimeInstallView | null;
  error: RuntimeErrorView | null;
  online: { available: boolean; reason: string | null; sizeBytes: number | null; fileName: string | null; urlHost: string | null; offlineUrl?: string | null; offlineUrls?: Array<{ name: string; url: string }>; offlineFileName?: string | null; offlineSizeBytes?: number | null };
  /** Sizes are real numbers produced by packaging, not estimates. */
  archiveBytes: number | null;
  payloadBytes: number | null;
  versions: RuntimeVersionView[];
  canRollback: boolean;
  canUninstall: boolean;
  busyTasks: number;
  bridgeProtocol: number;
  /** Sanitized diagnostics; never local absolute paths. */
  note: string | null;
}

export interface RuntimeProbeResult {
  ok: boolean;
  health: RuntimeHealth;
}

export interface RuntimeDownloadInfo {
  available: boolean;
  url: string | null;
  /** Ordered mirrors; the first entry is the primary download URL. */
  sources: Array<{ name: string; url: string }>;
  fileName: string | null;
  sizeBytes: number | null;
  reason: string | null;
}

export interface RuntimeUpdateInfo {
  supported: boolean;
  reason: string | null;
  available: RuntimeManifest | null;
}

export interface RuntimeAccess {
  engine(): import('../novel-fetch.ts').NovelEngineLike;
  acquire(): Promise<{ engine: import('../novel-fetch.ts').NovelEngineLike; release(): void }>;
  status(): RuntimeStatusView;
}
