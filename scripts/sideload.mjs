#!/usr/bin/env node
/**
 * 把扩展侧载进 Coopanion 数据目录：不带 node_modules，用宿主自己的 pnpm store 安装。
 * 用法: node scripts/sideload.mjs <coopanion-data-dir> [package-dir]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const dataDir = resolve(process.argv[2] ?? '');
const source = resolve(process.argv[3] ?? process.cwd());
if (!dataDir || !existsSync(dataDir)) {
  console.error('usage: node scripts/sideload.mjs <coopanion-data-dir> [package-dir]');
  process.exit(2);
}
const target = join(dataDir, 'local-extensions', 'bookfish-r2');
const extensions = join(dataDir, 'extensions');
mkdirSync(target, { recursive: true });
cpSync(source, target, {
  recursive: true,
  filter: (path) => !/[\\/](node_modules|\.git|output)$/.test(path) && !/[\\/]pnpm-lock\.yaml$/.test(path),
});
const manifest = join(extensions, 'package.json');
const pkg = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : { name: 'cortico-extensions', private: true, dependencies: {} };
pkg.dependencies = { ...(pkg.dependencies ?? {}), 'cortico-world-bookfish': `link:${target.replaceAll('\\', '/')}` };
writeFileSync(manifest, JSON.stringify(pkg, null, 2) + '\n');
// 用宿主自己的 pnpm 安装；不指定 --frozen-lockfile，避免旧锁文件冲突
execFileSync(process.platform === 'win32' ? 'corepack' : 'pnpm', process.platform === 'win32' ? ['pnpm', 'install', '--no-frozen-lockfile'] : ['install', '--no-frozen-lockfile'], { cwd: extensions, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
execFileSync(process.platform === 'win32' ? 'corepack' : 'pnpm', process.platform === 'win32' ? ['pnpm', 'install', '--no-frozen-lockfile'] : ['install', '--no-frozen-lockfile'], { cwd: target, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
console.log(`sideloaded ${target}`);