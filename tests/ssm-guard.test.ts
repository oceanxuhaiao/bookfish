/**
 * BF-GIT-20261119 · SSM 保护闸门的回归测试。
 *
 * 守护点：
 *  - SSM 专属模块（src/story/**、story 协议、SSM 测试）必须判为 blocked；
 *  - 未来新增的 story/ssm 命名文件默认 blocked，避免"新文件绕过清单"；
 *  - 共享文件（library/world/config 等）必须判为 review，而不是默默放行；
 *  - 普通模块、清单自身、Windows 反斜杠、大小写差异不能误伤或漏判。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyPaths,
  collectChangedPaths,
  exitCodeFor,
  loadManifest,
  normalizeRepoPath,
  parseArgs,
  parseManifest,
  parseNameStatus,
  summarize,
} from '../scripts/check-ssm-protected.mts';

const manifest = loadManifest();

function verdicts(paths: string[]) {
  return Object.fromEntries(classifyPaths(paths, manifest).map((item) => [item.path, item.verdict]));
}

describe('SSM 专属模块必须阻断', () => {
  it('blocks the story core and store', () => {
    expect(verdicts(['src/story/core.ts', 'src/story/store.ts'])).toEqual({
      'src/story/core.ts': 'blocked',
      'src/story/store.ts': 'blocked',
    });
  });

  it('blocks every file under the story directory, including future ones', () => {
    const result = verdicts(['src/story/recall.ts', 'src/story/deep/new-module.ts']);
    expect(result['src/story/recall.ts']).toBe('blocked');
    expect(result['src/story/deep/new-module.ts']).toBe('blocked');
  });

  it('blocks the story protocol and the SSM regression tests', () => {
    const result = verdicts([
      'src/protocol/story.md',
      'tests/story-core.test.ts',
      'tests/story-e2e.test.ts',
      'tests/predeploy-ssm-isolation.test.ts',
    ]);
    for (const verdict of Object.values(result)) expect(verdict).toBe('blocked');
  });

  it('blocks a brand-new story-named file that is not listed explicitly', () => {
    expect(verdicts(['src/story-index.ts'])['src/story-index.ts']).toBe('blocked');
    expect(verdicts(['tests/ssm-e2e.test.ts'])['tests/ssm-e2e.test.ts']).toBe('blocked');
  });

  it('does not confuse "history" or "storyboard" with the story module', () => {
    expect(verdicts(['src/history.ts'])['src/history.ts']).toBe('review');
    expect(verdicts(['tests/storyboard.test.ts'])['tests/storyboard.test.ts']).toBe('allowed');
  });
});

describe('共享 SSM 区段必须走 review', () => {
  it('marks shared wiring files as review, never as allowed', () => {
    const result = verdicts([
      'src/library.ts',
      'src/world.ts',
      'src/config.ts',
      'src/tool-schemas.ts',
      'src/stream-index.ts',
      'describe.json',
    ]);
    for (const verdict of Object.values(result)) expect(verdict).toBe('review');
  });

  it('fail-closes on review unless an explicit approval reason is recorded', () => {
    const summary = summarize(classifyPaths(['src/library.ts'], manifest));
    expect(exitCodeFor(summary, null)).toBe(1);
    expect(exitCodeFor(summary, '已获得 SSM 负责人同意')).toBe(0);
  });
});

describe('普通开发不得被误伤', () => {
  it('allows unrelated modules and docs', () => {
    const result = verdicts([
      'src/webui/style.ts',
      'src/biquge.ts',
      'tests/history.test.ts',
      'README.md',
      'package.json',
    ]);
    for (const verdict of Object.values(result)) expect(verdict).toBe('allowed');
  });

  it('exempts the guard mechanism itself', () => {
    const result = verdicts([
      'scripts/check-ssm-protected.mts',
      'scripts/ssm-protected-paths.json',
      'tests/ssm-guard.test.ts',
    ]);
    for (const verdict of Object.values(result)) expect(verdict).toBe('allowed');
  });

  it('normalizes Windows separators, leading ./ and casing', () => {
    expect(normalizeRepoPath('.\\src\\Story\\Core.ts')).toBe('src/story/core.ts');
    expect(verdicts(['.\\SRC\\STORY\\CORE.TS'])['src/story/core.ts']).toBe('blocked');
  });

  it('returns an empty classification for no changes', () => {
    expect(classifyPaths([], manifest)).toEqual([]);
    expect(exitCodeFor(summarize([]), null)).toBe(0);
  });
});

describe('清单自身的完整性', () => {
  it('refuses a manifest without blocked entries', () => {
    expect(() => parseManifest({ version: 1, blocked: [], review: [], exempt: [] })).toThrow(/blocked/);
  });

  it('refuses invalid name patterns', () => {
    expect(() => parseManifest({ version: 1, blocked: ['src/story/'], namePatterns: ['('] })).toThrow(/正则/);
  });

  it('keeps the shipped baseline version pinned to 0.62.1', () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'scripts/ssm-protected-paths.json'), 'utf8')) as { baseline: string };
    expect(raw.baseline).toContain('0.62.1');
    expect(raw.baseline).toContain('ea9b45be7eda6d63f0f1172a76585d794dbdb01f');
  });
});

describe('git 输出解析', () => {
  it('takes both sides of a rename', () => {
    expect(parseNameStatus('M\tsrc/a.ts\nR100\told/b.ts\tnew/b.ts\nA\tsrc/c.ts\n')).toEqual([
      'src/a.ts',
      'old/b.ts',
      'new/b.ts',
      'src/c.ts',
    ]);
  });

  it('parses CLI arguments and rejects a missing base', () => {
    expect(parseArgs(['--staged', '--base', 'main'])).toMatchObject({ staged: true, base: 'main' });
    expect(() => parseArgs(['--base'])).toThrow(/base/);
    expect(() => parseArgs(['--accept-review'])).toThrow(/理由/);
    expect(() => parseArgs(['--nope'])).toThrow(/未知参数/);
  });

  it('finds the repository root and reports real tracked changes', () => {
    const paths = collectChangedPaths({ root: process.cwd(), staged: true, base: 'origin/main' });
    expect(Array.isArray(paths)).toBe(true);
  });
});
