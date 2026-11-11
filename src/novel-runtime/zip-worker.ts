/**
 * Isolated ZIP extraction worker.
 *
 * Runs off the World thread because a runtime archive contains thousands of
 * files and hundreds of megabytes. Every entry is validated before it touches
 * disk: no traversal, absolute paths, drive letters, ADS, device names,
 * symlinks, case-collisions, oversized files or suspicious compression ratios.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import * as yauzl from 'yauzl';
import type { RuntimeFileEntry } from './types.ts';

interface WorkerInput {
  zipPath: string;
  destDir: string;
  limits?: { maxEntries?: number; maxTotalBytes?: number; maxEntryBytes?: number; maxCompressionRatio?: number };
}

type ZipFile = yauzl.ZipFile;

const DEFAULTS = { maxEntries: 12_000, maxTotalBytes: 1_200 * 1024 * 1024, maxEntryBytes: 512 * 1024 * 1024, maxCompressionRatio: 220 };

function invalidName(message: string): never {
  throw new Error(message);
}

function safeName(raw: string): string {
  if (!raw || raw.length > 260) invalidName('压缩包内文件名过长或为空');
  const name = raw.replace(/\/+$/u, '');
  if (!name) return '';
  if (name.includes('\\')) invalidName('压缩包包含反斜杠路径');
  if (name.includes('\0')) invalidName('压缩包包含空字节');
  if (name.startsWith('/') || /^[a-zA-Z]:/u.test(name)) invalidName('压缩包包含绝对路径');
  const parts = name.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') invalidName('压缩包包含路径穿越');
    if (part.endsWith('.') || part.endsWith(' ')) invalidName('压缩包包含非法文件名');
    if (/[<>:"|?*\u0000-\u001f]/u.test(part)) invalidName('压缩包包含非法字符');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu.test(part)) invalidName('压缩包包含 Windows 设备名');
  }
  return parts.join('/');
}

function modeOf(entry: yauzl.Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0xffff;
}

const input = workerData as WorkerInput;
const limits = { ...DEFAULTS, ...(input.limits ?? {}) };
const destRoot = resolve(input.destDir);
const seen = new Set<string>();
const files: RuntimeFileEntry[] = [];
let totalBytes = 0;
let entries = 0;
let settled = false;

function finish(): void {
  if (settled) return;
  settled = true;
  parentPort?.postMessage({ type: 'done', files, bytes: totalBytes });
}

function abort(code: string, message: string): void {
  if (settled) return;
  settled = true;
  parentPort?.postMessage({ type: 'error', code, message });
}

mkdirSync(destRoot, { recursive: true });

yauzl.open(input.zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (openError, zipFile?: ZipFile) => {
  if (openError || !zipFile) return abort('zip_invalid', `无法打开压缩包：${openError?.message ?? 'unknown'}`);
  zipFile.on('error', (error) => abort('zip_invalid', `压缩包读取失败：${error.message}`));
  zipFile.on('end', () => finish());
  zipFile.on('entry', (entry: yauzl.Entry) => {
    if (settled) return;
    if (entry.generalPurposeBitFlag & 0x1) return abort('zip_encrypted', '压缩包已加密');
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) return abort('zip_compression', '压缩包使用了不支持的压缩算法');
    let name: string;
    try { name = safeName(entry.fileName); } catch (error) { return abort('zip_entry_name', (error as Error).message); }
    const isDirectory = /\/$/u.test(entry.fileName);
    if (!name) { zipFile.readEntry(); return; }
    const key = name.toLowerCase();
    if (seen.has(key)) return abort('zip_duplicate', '压缩包包含大小写重复的文件名');
    seen.add(key);
    entries++;
    if (entries > limits.maxEntries) return abort('zip_too_many_entries', '压缩包文件数量超过限制');
    const mode = modeOf(entry);
    const type = mode & 0xf000;
    if (type === 0xa000) return abort('zip_symlink', '压缩包包含符号链接');
    if (type !== 0 && type !== 0x8000 && type !== 0x4000) return abort('zip_entry_type', '压缩包包含特殊文件');
    if (isDirectory || type === 0x4000) {
      if (entry.uncompressedSize !== 0) return abort('zip_entry_type', '目录条目带有数据');
      mkdirSync(join(destRoot, ...name.split('/')), { recursive: true });
      zipFile.readEntry();
      return;
    }
    if (entry.uncompressedSize > limits.maxEntryBytes) return abort('zip_entry_too_large', '压缩包内单个文件过大');
    if (entry.uncompressedSize > 1024 * 1024 && (entry.compressedSize === 0 || entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.maxCompressionRatio)) {
      return abort('zip_bomb', '压缩包压缩比异常');
    }
    totalBytes += entry.uncompressedSize;
    if (totalBytes > limits.maxTotalBytes) return abort('zip_too_large', '解压后总大小超过限制');
    const target = resolve(destRoot, ...name.split('/'));
    if (target !== destRoot && !target.startsWith(destRoot + sep)) return abort('zip_traversal', '压缩包路径越界');
    mkdirSync(dirname(target), { recursive: true });
    let fd: number;
    try { fd = openSync(target, 'wx', 0o600); } catch { return abort('zip_write', '无法写入解压文件'); }
    zipFile.openReadStream(entry, (streamError, stream) => {
      if (streamError || !stream) { closeSync(fd); return abort('zip_read', '无法读取压缩包条目'); }
      const hash = createHash('sha256');
      let written = 0;
      stream.on('data', (chunk: Buffer) => {
        if (settled) { stream.destroy(); return; }
        written += chunk.length;
        if (written > entry.uncompressedSize) { stream.destroy(); closeSync(fd); return abort('zip_size', '压缩包条目实际大小异常'); }
        hash.update(chunk);
        try { let offset = 0; while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset, null); }
        catch { stream.destroy(); closeSync(fd); abort('zip_write', '写入解压文件失败'); }
      });
      stream.on('error', () => { try { closeSync(fd); } catch { /* already closed */ } abort('zip_read', '解压数据流中断'); });
      stream.on('end', () => {
        closeSync(fd);
        if (settled) return;
        if (written !== entry.uncompressedSize) return abort('zip_size', '压缩包条目大小与声明不符');
        let actual = 0;
        try { actual = statSync(target).size; } catch { return abort('zip_write', '解压文件丢失'); }
        if (actual !== written) return abort('zip_write', '解压文件大小不符');
        files.push({ path: name, size: written, sha256: hash.digest('hex') });
        zipFile.readEntry();
      });
    });
  });
  zipFile.readEntry();
});
