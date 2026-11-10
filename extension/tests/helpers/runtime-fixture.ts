import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { ZipFile } from 'yazl';
import type { RuntimeManifest, TrustedRuntimeManifest } from '../../src/novel-runtime/types.ts';

function sha256(file: string): string { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

function listFiles(base: string, dir = ''): string[] {
  const rows: string[] = [];
  for (const entry of readdirSync(join(base, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) rows.push(...listFiles(base, rel));
    else rows.push(rel);
  }
  return rows.sort();
}

export interface RuntimeFixture { manifest: TrustedRuntimeManifest; zipPath: string; payloadDir: string }

/** Build a tiny but structurally real runtime package for manager tests. */
export async function createRuntimeFixture(root: string, options: { runtimeId?: string; runtimeVersion?: string; appJar?: string } = {}): Promise<RuntimeFixture> {
  const payloadDir = join(root, 'payload');
  const runtimeId = options.runtimeId ?? 'bookfish-runtime-test-1-win32-x64';
  const files: Record<string, string> = {
    'app.jar': options.appJar ?? 'fake-app-jar',
    'rules/main.json': '[{"name":"fixture-source","url":"https://example.invalid/"}]',
    'runtime/bin/java.exe': 'fake-java',
    'runtime/release': 'JAVA_VERSION="21.0.8"\nFULL_VERSION="21.0.8+9-LTS"\nIMPLEMENTOR="Eclipse Adoptium"\n',
    'licenses/NOTICE.txt': 'fixture license\n',
  };
  for (const [path, content] of Object.entries(files)) {
    const target = join(payloadDir, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  const entries = listFiles(payloadDir).map((path) => {
    const full = join(payloadDir, ...path.split('/'));
    return { path, size: statSync(full).size, sha256: sha256(full) };
  });
  const manifest: RuntimeManifest = {
    schema: 1, runtimeId, runtimeVersion: options.runtimeVersion ?? 'test1',
    platform: 'win32', arch: 'x64', soNovelVersion: '1.12.0', bridgeProtocol: 1, extensionApi: 6,
    java: { vendor: 'Eclipse Adoptium', version: '21.0.8+9-LTS', major: 21 },
    rules: { path: 'rules/main.json', sha256: sha256(join(payloadDir, 'rules', 'main.json')), sources: 1 },
    payloadBytes: entries.reduce((sum, entry) => sum + entry.size, 0), payloadFiles: entries.length,
    files: entries, createdAt: '2026-11-10T00:00:00.000Z',
    source: { url: 'https://example.invalid/so-novel', commit: 'test' },
  };
  writeFileSync(join(payloadDir, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const zipPath = join(root, `${runtimeId}.zip`);
  await new Promise<void>((resolve, reject) => {
    const zip = new ZipFile();
    const output = createWriteStream(zipPath, { flags: 'wx' });
    output.on('error', reject);
    output.on('close', () => resolve());
    zip.outputStream.pipe(output);
    const mtime = new Date('2026-11-10T00:00:00.000Z');
    for (const path of listFiles(payloadDir)) {
      zip.addFile(join(payloadDir, ...path.split('/')), path, { mtime, mode: 0o644, compress: true });
    }
    zip.end();
  });
  const trusted: TrustedRuntimeManifest = { ...manifest, archive: { path: `${runtimeId}.zip`, size: statSync(zipPath).size, sha256: sha256(zipPath) } };
  return { manifest: trusted, zipPath, payloadDir };
}

export function zipEntries(root: string): string[] {
  return listFiles(root).map((path) => path.split(sep).join('/'));
}

export function fileSha(file: string): string { return sha256(file); }
