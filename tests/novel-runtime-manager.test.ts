import { describe, expect, it, afterEach } from 'vitest';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { NovelRuntimeManager } from '../src/novel-runtime/manager.ts';
import { createRuntimeFixture } from './helpers/runtime-fixture.ts';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import type { DownloadOptions } from '../src/novel-runtime/download.ts';
import { downloadRuntimeArchive } from '../src/novel-runtime/download.ts';
import type { TrustedRuntimeManifest } from '../src/novel-runtime/types.ts';

const roots: string[] = [];
function temp(): string { const dir = mkdtempSync(join(tmpdir(), 'bookfish-manager-')); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function makeManager(dataDir: string, fixture: Awaited<ReturnType<typeof createRuntimeFixture>>, extra: Partial<ConstructorParameters<typeof NovelRuntimeManager>[0]> = {}): NovelRuntimeManager {
  return new NovelRuntimeManager({
    dataDir, workDir: join(dataDir, 'bookfish', 'novel-fetch'), bridgeClasses: join(dataDir, 'bridge'), manifest: fixture.manifest,
    baseUrl: 'https://runtime.example.test/', allowedHosts: ['runtime.example.test'],
    probe: async () => ({ state: 'ok', checkedAt: new Date().toISOString(), message: 'ok', javaMajor: 21, bridgeProtocol: 1 }),
    extract: async (_zip, dest, signal) => {
      if (signal?.aborted) throw new Error('cancelled');
      cpSync(fixture.payloadDir, dest, { recursive: true });
      return { files: fixture.manifest.files, bytes: fixture.manifest.payloadBytes };
    },
    download: async (options: DownloadOptions) => {
      copyFileSync(fixture.zipPath, options.dest);
      const size = fixture.manifest.archive.size;
      options.onProgress?.(size, size);
      return { bytes: size };
    },
    ...extra,
  });
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function upload(manager: NovelRuntimeManager, zipPath: string): Promise<void> {
  const data = readFileSync(zipPath);
  const begin = manager.importBegin({ size: data.length, filename: 'runtime.zip' });
  let offset = 0;
  while (offset < data.length) {
    const chunk = data.subarray(offset, offset + begin.chunkBytes);
    const result = manager.importChunk(begin.id, offset, chunk.toString('base64'));
    offset = result.offset;
  }
  manager.importFinish(begin.id);
}

function terminal(manager: NovelRuntimeManager): boolean {
  const phase = manager.status().install?.phase;
  return phase === 'ready' || phase === 'failed' || phase === 'cancelled' || phase === 'interrupted' || phase === undefined;
}

describe('novel runtime manager', () => {
  it('uses the domestic mirror first and GitHub as the built-in fallback', async () => {
    const dir = temp(); const fixture = await createRuntimeFixture(join(dir, 'fixture'));
    const manager = new NovelRuntimeManager({
      dataDir: dir, workDir: join(dir, 'bookfish', 'novel-fetch'), bridgeClasses: join(dir, 'bridge'), manifest: fixture.manifest,
    });
    const status = manager.status();
    expect(status.online.available).toBe(true);
    expect(status.online.urlHost).toBe('bookfish-runtime.oss-cn-hangzhou.aliyuncs.com');
    expect(status.online.offlineUrls?.map((entry) => entry.name)).toEqual(['国内镜像', 'GitHub Release']);
    const info = await manager.downloadInfo();
    expect(info.url).toBeTruthy();
    expect(info.url!).toContain('bookfish-runtime.oss-cn-hangzhou.aliyuncs.com/');
    expect(info.url!.endsWith('.zip')).toBe(true);
    expect(info.sources.map((entry) => entry.name)).toEqual(['国内镜像', 'GitHub Release']);
  });
  it('falls back to GitHub when the domestic mirror download fails', async () => {
    const dir = temp(); const fixture = await createRuntimeFixture(join(dir, 'fixture'));
    const calls: string[] = [];
    const manager = makeManager(dir, fixture, {
      baseUrl: undefined, allowedHosts: undefined,
      download: async (options: DownloadOptions) => {
        calls.push(options.url);
        if (calls.length === 1) throw new Error('mirror unavailable');
        copyFileSync(fixture.zipPath, options.dest);
        const size = fixture.manifest.archive.size;
        options.onProgress?.(size, size);
        return { bytes: size };
      },
    });
    await manager.start();
    manager.installOnline();
    await waitFor(() => terminal(manager), 'mirror fallback install');
    expect(manager.status().install?.phase).toBe('ready');
    expect(calls[0]).toContain('bookfish-runtime.oss-cn-hangzhou.aliyuncs.com');
    expect(calls[1]).toContain('github.com/oceanxuhaiao/bookfish/releases/download/runtime-1.12.0-bf1/');
  });

  it('installs an offline ZIP through staging, self-check and atomic activation', async () => {
    const dir = temp(); const fixture = await createRuntimeFixture(join(dir, 'fixture'));
    const manager = makeManager(dir, fixture);
    await manager.start();
    expect(manager.status().installed).toBe(false);
    await upload(manager, fixture.zipPath);
    await waitFor(() => terminal(manager), 'offline install');
    const status = manager.status();
    expect(status.install?.phase).toBe('ready');
    expect(status.usable).toBe(true);
    expect(status.source).toBe('managed');
    expect(existsSync(join(dir, 'bookfish', 'novel-engine', 'active.json'))).toBe(true);
    const versions = readdirSync(join(dir, 'bookfish', 'novel-engine', 'versions'));
    expect(versions).toHaveLength(1);
    expect(existsSync(join(dir, 'bookfish', 'novel-engine', 'versions', versions[0]!, '.bookfish-runtime.json'))).toBe(true);
    expect((await manager.acquire()).engine).toBeTruthy();
  });

  it('keeps the old runtime when a new archive fails verification', async () => {
    const dir = temp(); const fixture = await createRuntimeFixture(join(dir, 'fixture'));
    const manager = makeManager(dir, fixture);
    await manager.start(); await upload(manager, fixture.zipPath);
    await waitFor(() => terminal(manager), 'first install');
    const runtimeId = manager.status().runtimeId;

    const corruptDir = join(dir, 'corrupt'); mkdirSync(corruptDir, { recursive: true });
    const corrupt = join(corruptDir, 'bad.zip');
    writeFileSync(corrupt, Buffer.concat([readFileSync(fixture.zipPath), Buffer.from('tampered')]));
    await upload(manager, corrupt);
    await waitFor(() => terminal(manager), 'failed install');
    expect(manager.status().install?.phase).toBe('failed');
    expect(manager.status().install?.error?.code).toBe('archive_hash');
    expect(manager.status().usable).toBe(true);
    expect(manager.status().runtimeId).toBe(runtimeId);
  });

  it('waits for an in-flight engine lease before switching, then rolls back', async () => {
    const dir = temp();
    const fixtureA = await createRuntimeFixture(join(dir, 'a'), { runtimeId: 'bookfish-runtime-a-win32-x64', runtimeVersion: 'a1' });
    const managerA = makeManager(dir, fixtureA);
    await managerA.start(); await upload(managerA, fixtureA.zipPath);
    await waitFor(() => terminal(managerA), 'install A');
    expect(managerA.status().runtimeId).toBe('bookfish-runtime-a-win32-x64');

    const fixtureB = await createRuntimeFixture(join(dir, 'b'), { runtimeId: 'bookfish-runtime-b-win32-x64', runtimeVersion: 'b1' });
    const managerB = makeManager(dir, fixtureB);
    await managerB.start();
    expect(managerB.status().runtimeId).toBe('bookfish-runtime-a-win32-x64');
    const lease = await managerB.acquire();
    managerB.installOnline();
    await waitFor(() => managerB.status().install?.phase === 'waiting_idle', 'waiting for idle');
    expect(managerB.status().runtimeId).toBe('bookfish-runtime-a-win32-x64');
    lease.release();
    await waitFor(() => terminal(managerB), 'install B');
    expect(managerB.status().runtimeId).toBe('bookfish-runtime-b-win32-x64');
    expect(managerB.status().canRollback).toBe(true);
    const rolled = await managerB.rollback();
    expect(rolled.runtimeId).toBe('bookfish-runtime-a-win32-x64');
  });

  it('cancels a slow download without touching the active runtime', async () => {
    const dir = temp(); const fixture = await createRuntimeFixture(join(dir, 'fixture'));
    const manager = makeManager(dir, fixture, {
      download: (options: DownloadOptions) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }),
    });
    await manager.start(); await upload(manager, fixture.zipPath);
    await waitFor(() => terminal(manager), 'offline install');
    const runtimeId = manager.status().runtimeId;
    manager.installOnline();
    await waitFor(() => manager.status().install?.phase === 'downloading', 'download start');
    manager.cancel();
    await waitFor(() => manager.status().install?.phase === 'cancelled', 'cancel');
    expect(manager.status().runtimeId).toBe(runtimeId);
    expect(manager.status().usable).toBe(true);
  });

  it('marks an install interrupted when the host stops during download', async () => {
    const dir = temp(); const fixture = await createRuntimeFixture(join(dir, 'fixture'));
    const manager = makeManager(dir, fixture, {
      download: (options: DownloadOptions) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }),
    });
    await manager.start();
    manager.installOnline();
    await waitFor(() => manager.status().install?.phase === 'downloading', 'download start');
    await manager.stop();
    expect(manager.status().install?.phase).toBe('interrupted');
    expect(manager.status().install?.error?.code).toBe('interrupted');
  });

  it('adopts a pinned legacy flat directory and never deletes it on uninstall', async () => {
    const dir = temp(); const fixture = await createRuntimeFixture(join(dir, 'fixture'));
    const base = join(dir, 'bookfish', 'novel-engine');
    mkdirSync(join(base, 'runtime', 'bin'), { recursive: true });
    mkdirSync(join(base, 'rules'), { recursive: true });
    writeFileSync(join(base, 'app.jar'), readFileSync(join(fixture.payloadDir, 'app.jar')));
    writeFileSync(join(base, 'runtime', 'bin', 'java.exe'), 'fake');
    writeFileSync(join(base, 'rules', 'main.json'), readFileSync(join(fixture.payloadDir, 'rules', 'main.json')));
    writeFileSync(join(base, 'readme.txt'), 'legacy extra file');
    const manager = makeManager(dir, fixture);
    await manager.start();
    const status = manager.status();
    expect(status.usable).toBe(true);
    expect(status.source).toBe('legacy');
    expect(status.canUninstall).toBe(false);
    await expect(manager.uninstall()).rejects.toThrow(/旧版/);
    expect(existsSync(join(base, 'readme.txt'))).toBe(true);
  });

  it('marks an interrupted install at startup and leaves books/downloads untouched on uninstall', async () => {
    const dir = temp(); const fixture = await createRuntimeFixture(join(dir, 'fixture'));
    const manager = makeManager(dir, fixture);
    await manager.start(); await upload(manager, fixture.zipPath);
    await waitFor(() => terminal(manager), 'install');
    mkdirSync(join(dir, 'bookfish', 'novel-fetch', 'fetch'), { recursive: true });
    writeFileSync(join(dir, 'bookfish', 'novel-fetch', 'fetch', 'keep.json'), '{"keep":true}', 'utf8');
    await writeFileSync(join(dir, 'bookfish', 'novel-engine', 'installs', '00000000-0000-4000-8000-000000000000.json'), JSON.stringify({ schema: 1, installId: '00000000-0000-4000-8000-000000000000', kind: 'online', phase: 'downloading', runtimeId: 'x', bytesReceived: 1, bytesTotal: 2, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null }));
    const restarted = makeManager(dir, fixture);
    await restarted.start();
    expect(restarted.status().error?.code).toBe('interrupted');
    expect(restarted.status().usable).toBe(true);
    await restarted.uninstall();
    expect(restarted.status().installed).toBe(false);
    expect(existsSync(join(dir, 'bookfish', 'novel-fetch', 'fetch', 'keep.json'))).toBe(true);
  });

  it('streams and verifies a real online download from an isolated loopback origin', async () => {
    const dir = temp(); const fixture = await createRuntimeFixture(join(dir, 'fixture'));
    const server = createServer((request, response) => {
      if (request.url !== `/${fixture.manifest.archive.path}`) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-length': fixture.manifest.archive.size, 'content-type': 'application/zip' });
      createReadStream(fixture.zipPath).pipe(response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const manager = makeManager(dir, fixture, {
        baseUrl: `http://127.0.0.1:${port}/`, allowedHosts: ['127.0.0.1'], allowInsecureLoopback: true,
        download: downloadRuntimeArchive,
      });
      await manager.start();
      expect(manager.status().online.available).toBe(true);
      manager.installOnline();
      await waitFor(() => terminal(manager), 'online install', 30_000);
      expect(manager.status().install?.phase).toBe('ready');
      expect(manager.status().install?.kind).toBe('online');
      expect(manager.status().usable).toBe(true);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it('rejects unsupported platform and unconfigured online source without inventing a URL', async () => {
    const dir = temp(); const fixture = await createRuntimeFixture(join(dir, 'fixture'));
    const manager = makeManager(dir, fixture, { baseUrl: null, allowedHosts: [] });
    await manager.start();
    const status = manager.status();
    expect(status.online.available).toBe(false);
    expect(status.online.reason).toContain('尚未配置');
    expect(() => manager.installOnline()).toThrow(/尚未配置/);
    const info = await manager.downloadInfo();
    expect(info.available).toBe(false);
    expect(info.url).toBeNull();
  });
});
