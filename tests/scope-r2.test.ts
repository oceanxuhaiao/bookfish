/**
 * R2 阶段 4：功能范围核验。
 *  - 自主选书（autonomousAcquisition）默认关闭；
 *  - SSM（storyMemoryEnabled）默认关闭，且关闭时不创建任何故事记忆存储。
 * 只做确定性核验，不做生产模型测试。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOOKFISH_DEFAULTS } from '../src/config.ts';
import { Library } from '../src/library.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bookfish-scope-r2-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 句柄 */ } });

describe('feature scope', () => {
  it('autonomous book acquisition is off by default and is a user-visible switch', () => {
    expect(BOOKFISH_DEFAULTS.autonomousAcquisition).toBe(false);
    expect(BOOKFISH_DEFAULTS.autonomousAcquisitionMode).toBe('auto');
    // 关闭时不提供书源，也就不会在真实环境里发起获取。
    expect(String(BOOKFISH_DEFAULTS.autonomousSourceIds)).toBe('');
  });

  it('story memory is off by default', () => {
    expect(BOOKFISH_DEFAULTS.storyMemoryEnabled).toBe(false);
  });

  it('with story memory off, no story store or sidecar is created', () => {
    const library = new Library({ dataDir: dir, now: () => 1_000_000 });
    library.open();
    const text = '黎望把灯芯剪短了一点。' + '风从东边来。'.repeat(20);
    const key = library.import({ filename: 's.txt', title: '关闭样本', base64: Buffer.from(text, 'utf8').toString('base64') }).book.key;
    library.select(key);
    for (;;) {
      const batch = library.readNext(1) as any;
      if (!batch?.segments?.length) break;
      for (const item of batch.segments) {
        library.finish({ taskId: item.taskId, bookKey: key, segmentId: item.segmentId, understanding: '读过了。',
          episode: { trigger: '剪灯芯', interpretation: '她在守夜。', evidence: [{ segmentId: item.segmentId, quote: '黎望把灯芯剪短了一点' }] } });
      }
    }
    library.reflect({ bookKey: key, requestId: 'r-1', episode: { trigger: '后来想', interpretation: '更像是等船。', evidence: [{ segmentId: 0, quote: '灯芯剪短' }] } });
    library.close();
    const files = readdirSync(dir);
    expect(files.some((name) => name.startsWith('story'))).toBe(false);
    expect(existsSync(join(dir, 'story.sqlite'))).toBe(false);
    // 普通 Episode 仍然照常记录，不受 SSM 关闭影响。
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((name) => name.startsWith('story'))).toBe(false);
  });
});
