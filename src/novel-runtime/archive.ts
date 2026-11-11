/** Main-thread wrapper around the extraction worker and payload verification. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { parseRuntimeManifest, payloadManifestMatches, sha256File } from './manifest.ts';
import type { RuntimeFileEntry, TrustedRuntimeManifest } from './types.ts';

export const ZIP_WORKER = new URL('../../lib/zip-worker.mjs', import.meta.url);

export interface ExtractOutcome { files: RuntimeFileEntry[]; bytes: number }

export class RuntimeArchiveError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'RuntimeArchiveError'; }
}

export function extractRuntimeZip(zipPath: string, destDir: string, signal?: AbortSignal, onProgress?: (files: number, bytes: number) => void): Promise<ExtractOutcome> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new RuntimeArchiveError('cancelled', '已取消'));
    let settled = false;
    const worker = new Worker(ZIP_WORKER, { workerData: { zipPath, destDir } });
    const finish = (error: Error | null, result?: ExtractOutcome): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const onAbort = (): void => finish(new RuntimeArchiveError('cancelled', '已取消'));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (message: { type?: string; files?: RuntimeFileEntry[]; bytes?: number; code?: string; message?: string }) => {
      if (message.type === 'progress') onProgress?.(message.files?.length ?? 0, message.bytes ?? 0);
      else if (message.type === 'done') finish(null, { files: message.files ?? [], bytes: message.bytes ?? 0 });
      else if (message.type === 'error') finish(new RuntimeArchiveError(message.code ?? 'zip', message.message ?? '解压失败'));
    });
    worker.on('error', (error) => finish(new RuntimeArchiveError('zip_worker', `解压失败：${error.message}`)));
    worker.on('exit', (code) => { if (!settled && code !== 0) finish(new RuntimeArchiveError('zip_worker', `解压进程退出（${code}）`)); });
  });
}

/** Compare an extracted tree with the manifest. Any extra file is a failure. */
export async function verifyExtractedPayload(dir: string, manifest: TrustedRuntimeManifest): Promise<void> {
  const expected = new Map(manifest.files.map((file) => [file.path, file] as const));
  const seen = new Set<string>();
  const walk = async (base: string, relative: string): Promise<void> => {
    for (const entry of readdirSync(join(base, relative), { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(base, rel);
      else if (entry.isFile()) {
        // The manifest describes the payload only; it cannot list itself.
        // The activation marker is Bookfish metadata, not payload.
        if (rel === 'runtime-manifest.json' || rel === '.bookfish-runtime.json') continue;
        const file = expected.get(rel);
        if (!file) throw new Error(`运行时包包含清单外文件：${rel}`);
        if (seen.has(rel)) throw new Error(`运行时包文件重复：${rel}`);
        seen.add(rel);
        const full = join(base, ...rel.split('/'));
        if (statSync(full).size !== file.size) throw new Error(`运行时文件大小不符：${rel}`);
        if (await sha256File(full) !== file.sha256) throw new Error(`运行时文件摘要不符：${rel}`);
      } else throw new Error(`运行时包包含非普通文件：${rel}`);
    }
  };
  await walk(dir, '');
  for (const path of expected.keys()) if (!seen.has(path)) throw new Error(`运行时包缺少文件：${path}`);
  // The in-archive manifest must describe exactly the pinned payload.
  const manifestPath = join(dir, 'runtime-manifest.json');
  if (!existsSync(manifestPath)) throw new Error('运行时包缺少 runtime-manifest.json');
  let inner;
  try { inner = parseRuntimeManifest(JSON.parse(readFileSync(manifestPath, 'utf8'))); }
  catch (error) { throw new Error(`运行时包清单无效：${(error as Error).message}`); }
  if (!payloadManifestMatches(inner, manifest)) throw new Error('运行时包清单与受信摘要不一致');
}
