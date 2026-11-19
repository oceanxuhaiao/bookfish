/**
 * BF-GIT-20261119 · SSM 受保护文件检查器（protected-path guard）
 *
 * 目的：把《SSM 保护清单》从“文档约定”变成“提交前可执行的闸门”，防止 Bugfix 开发
 * 误改故事骨架系统（SSM）的代码、协议、测试或数据契约。
 *
 * 判定来源：scripts/ssm-protected-paths.json
 *  - blocked：SSM 专属模块，禁止 Bugfix 修改（含未来新增的 src/story/* 文件）。
 *  - review ：共享文件中的 SSM 区段，必须经 SSM 负责人确认，显式传入理由后才放行。
 *  - exempt ：本机制自身文件，不算越界。
 *  - namePatterns：无法确定归属的 story/ssm 命名文件，按受保护处理。
 *
 * 用法（在仓库根目录）：
 *   node --import tsx scripts/check-ssm-protected.mts                  # 工作区 + 未跟踪文件 vs origin/main
 *   node --import tsx scripts/check-ssm-protected.mts --staged         # 仅暂存区（commit 前）
 *   node --import tsx scripts/check-ssm-protected.mts --base origin/main
 *   node --import tsx scripts/check-ssm-protected.mts --json
 *   node --import tsx scripts/check-ssm-protected.mts --accept-review "已获得 SSM 负责人 XXX 同意"
 *
 * 退出码：0 通过；1 存在 blocked 或未获确认的 review；2 清单/参数错误；3 git 调用失败。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Verdict = 'allowed' | 'review' | 'blocked';

export interface Manifest {
  version: number;
  blocked: string[];
  review: string[];
  exempt: string[];
  namePatterns: string[];
}

export interface Finding {
  path: string;
  verdict: Verdict;
  rule: string;
}

export interface Summary {
  blocked: Finding[];
  review: Finding[];
  allowed: Finding[];
  findings: Finding[];
}

const HERE = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_MANIFEST_PATH = join(HERE, 'ssm-protected-paths.json');

/** 仓库内的路径统一成小写 POSIX 形式，消除 Windows 反斜杠与大小写差异。 */
export function normalizeRepoPath(value: string): string {
  return value
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .trim()
    .toLowerCase();
}

function requireStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`清单字段 ${field} 必须是字符串数组`);
  }
  return value.map(normalizeRepoPath);
}

export function parseManifest(raw: unknown): Manifest {
  if (!raw || typeof raw !== 'object') throw new Error('清单不是 JSON 对象');
  const source = raw as Record<string, unknown>;
  const version = Number(source.version);
  if (!Number.isInteger(version) || version < 1) throw new Error('清单字段 version 必须是正整数');
  const manifest: Manifest = {
    version,
    blocked: requireStringArray(source.blocked, 'blocked'),
    review: requireStringArray(source.review, 'review'),
    exempt: requireStringArray(source.exempt, 'exempt'),
    namePatterns: Array.isArray(source.namePatterns)
      ? source.namePatterns.map((item) => String(item))
      : [],
  };
  if (!manifest.blocked.length) throw new Error('清单 blocked 不能为空，否则闸门形同虚设');
  for (const pattern of manifest.namePatterns) {
    try { new RegExp(pattern, 'i'); }
    catch { throw new Error(`清单 namePatterns 含非法正则：${pattern}`); }
  }
  return manifest;
}

export function loadManifest(path: string = DEFAULT_MANIFEST_PATH): Manifest {
  return parseManifest(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function matchEntry(path: string, entries: string[]): string | null {
  for (const entry of entries) {
    if (!entry) continue;
    if (entry.endsWith('/')) {
      if (path.startsWith(entry)) return entry;
      continue;
    }
    if (path === entry) return entry;
  }
  return null;
}

/** 纯函数：把路径列表分类。测试直接调用此函数，不依赖 git。 */
export function classifyPaths(paths: readonly string[], manifest: Manifest): Finding[] {
  const patterns = manifest.namePatterns.map((pattern) => new RegExp(pattern, 'i'));
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const candidate of paths) {
    const path = normalizeRepoPath(candidate);
    if (!path || seen.has(path)) continue;
    seen.add(path);

    if (matchEntry(path, manifest.exempt)) {
      findings.push({ path, verdict: 'allowed', rule: 'exempt' });
      continue;
    }
    const blockedBy = matchEntry(path, manifest.blocked);
    if (blockedBy) {
      findings.push({ path, verdict: 'blocked', rule: blockedBy });
      continue;
    }
    const namedPattern = patterns.find((pattern) => pattern.test(path));
    if (namedPattern) {
      findings.push({ path, verdict: 'blocked', rule: `namePattern:${namedPattern.source}` });
      continue;
    }
    const reviewBy = matchEntry(path, manifest.review);
    if (reviewBy) {
      findings.push({ path, verdict: 'review', rule: reviewBy });
      continue;
    }
    findings.push({ path, verdict: 'allowed', rule: 'not-protected' });
  }
  return findings;
}

export function summarize(findings: readonly Finding[]): Summary {
  return {
    blocked: findings.filter((item) => item.verdict === 'blocked'),
    review: findings.filter((item) => item.verdict === 'review'),
    allowed: findings.filter((item) => item.verdict === 'allowed'),
    findings: [...findings],
  };
}

/** 解析 `git diff --name-status` 输出，重命名/复制的旧路径与新路径都算改动。 */
export function parseNameStatus(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    for (const part of parts.slice(1)) if (part.trim()) paths.push(part.trim());
  }
  return paths;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export interface CollectOptions {
  root: string;
  staged: boolean;
  base: string;
}

/** 取本次改动涉及的路径：已提交到分支的、暂存的、未暂存的、未跟踪的。 */
export function collectChangedPaths(options: CollectOptions): string[] {
  const paths: string[] = [];
  if (options.staged) {
    paths.push(...parseNameStatus(git(options.root, ['diff', '--cached', '--name-status'])));
  } else {
    paths.push(...parseNameStatus(git(options.root, ['diff', '--name-status', options.base])));
    paths.push(...parseNameStatus(git(options.root, ['diff', '--cached', '--name-status'])));
    const untracked = git(options.root, ['ls-files', '--others', '--exclude-standard']);
    paths.push(...untracked.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  }
  return paths;
}

interface CliOptions {
  staged: boolean;
  base: string;
  json: boolean;
  acceptReview: string | null;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { staged: false, base: 'origin/main', json: false, acceptReview: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--staged') options.staged = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--base') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--base 需要一个 git ref');
      options.base = value;
      index += 1;
    } else if (arg === '--accept-review') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--accept-review 需要一个书面理由');
      options.acceptReview = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.json = false;
      throw new Error('help');
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

export function exitCodeFor(summary: Summary, acceptReview: string | null): number {
  if (summary.blocked.length) return 1;
  if (summary.review.length && !acceptReview) return 1;
  return 0;
}

const USAGE = `用法: node --import tsx scripts/check-ssm-protected.mts [--staged] [--base <ref>] [--json] [--accept-review <理由>]`;

function report(summary: Summary, options: CliOptions, manifest: Manifest): void {
  if (options.json) {
    console.log(JSON.stringify({ base: options.base, staged: options.staged, manifestVersion: manifest.version, ...summary }, null, 2));
    return;
  }
  const scope = options.staged ? 'staged only' : `working tree vs ${options.base}`;
  console.log(`SSM protected-path guard — ${scope} (manifest v${manifest.version})`);
  const labels: Record<Verdict, string> = { blocked: 'BLOCKED', review: 'REVIEW ', allowed: 'ok      ' };
  for (const finding of summary.findings) {
    console.log(`  ${labels[finding.verdict]} ${finding.path.padEnd(52)} [${finding.rule}]`);
  }
  if (!summary.findings.length) console.log('  (no changes)');
  console.log('');
  console.log(`结论: blocked=${summary.blocked.length} review=${summary.review.length} allowed=${summary.allowed.length}`);
  if (summary.blocked.length) {
    console.log('停止：上述 blocked 文件属于 SSM 专属模块，Bugfix 分支不得修改。');
    console.log('处理：撤回这些文件的改动，或按规范提交冲突分析报告，等待用户显式授权。');
  } else if (summary.review.length) {
    if (options.acceptReview) {
      console.log(`已登记 review 放行理由：${options.acceptReview}`);
    } else {
      console.log('停止：上述 review 文件含 SSM 共享区段，需要 SSM 负责人确认。');
      console.log('确认后使用：--accept-review "已获得 XXX 同意：<范围与理由>"');
    }
  }
}

function main(argv: readonly string[]): number {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    const message = String((error as Error).message ?? error);
    if (message !== 'help') console.error(`参数错误：${message}`);
    console.log(USAGE);
    return message === 'help' ? 0 : 2;
  }

  let root: string;
  let manifest: Manifest;
  try {
    root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
    manifest = loadManifest();
  } catch (error) {
    console.error(`无法初始化：${String((error as Error).message ?? error)}`);
    return error instanceof SyntaxError ? 2 : 3;
  }

  let changed: string[];
  try {
    changed = collectChangedPaths({ root, staged: options.staged, base: options.base });
  } catch (error) {
    console.error(`git 调用失败（base=${options.base}）：${String((error as Error).message ?? error)}`);
    return 3;
  }

  const summary = summarize(classifyPaths(changed, manifest));
  report(summary, options, manifest);
  return exitCodeFor(summary, options.acceptReview);
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const invoked = realpathSync(resolve(entry));
    return self.toLowerCase() === invoked.toLowerCase();
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
