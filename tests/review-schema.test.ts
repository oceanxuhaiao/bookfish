/**
 * P03 / BF-PROMPT-OPT-002 阶段 4：`bookfish_review` 七个动作的 requestId 契约。
 *
 * 两个方向都要钉住：
 *   - Schema 不能要求只读动作携带无意义的 id；
 *   - 真正需要 id 的 `begin` 必须被模型看见这条规则，而且缺参时的报错要能自纠正。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BOOKFISH_TOOL_DECLS } from '../src/tool-schemas.ts';
import { BOOKFISH } from '../src/definition.ts';
import { beginReview, failReview, finishReview, reviewMaterials } from '../src/reviews.ts';
import type { LibraryState } from '../src/library.ts';
import { FakeHost } from './helpers/fake-host.ts';

const reviewDecl = BOOKFISH_TOOL_DECLS.find((decl) => decl.name === 'bookfish_review')!;
const properties = reviewDecl.parameters.properties as Record<string, { description?: string }>;

let scratch: string;
const mounted: Array<{ stop: () => Promise<void> }> = [];
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'bookfish-review-schema-')); mounted.length = 0; });
afterEach(async () => {
  for (const entry of mounted) { try { await entry.stop(); } catch { /* 已停 */ } }
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 句柄 */ }
});

async function mount() {
  const ctx = fakeWorldContext(BOOKFISH, { scratchDir: scratch });
  ctx.persist({ automaticReading: false, realRoutineEnabled: false, readingBatchSegments: 1 });
  const world = BOOKFISH.create(ctx);
  mounted.push(world as unknown as { stop: () => Promise<void> });
  await world.start(new FakeHost());
  const invoke = world.webUi!('zh').invoke!;
  const imported = await invoke('status', 'import', [{ filename: 'r.txt', title: '评论样本', author: '测试', base64: Buffer.from('潮水打在礁石上。'.repeat(200), 'utf8').toString('base64') }]) as { book: { key: string } };
  await invoke('status', 'select', [imported.book.key]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const decl = world.tools().find((entry) => entry.name === name)!;
    try { return { ok: true as const, value: JSON.parse(await decl.handler(args, {} as ToolCallContext) as string) }; }
    catch (error) { return { ok: false as const, error: String((error as Error)?.message ?? error) }; }
  };
  return { world, invoke, call, key: imported.book.key };
}

describe('bookfish_review: only begin takes a requestId', () => {
  it('does not list requestId as required, and says where it is needed', () => {
    expect(reviewDecl.parameters.required).toEqual(['action']);
    expect(String(properties.requestId.description)).toMatch(/begin/);
    expect(String(properties.requestId.description)).toMatch(/ASCII/i);
  });

  it('only beginReview reads args.requestId (source-level check)', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'reviews.ts'), 'utf8');
    const bodyOf = (name: string) => {
      const start = source.indexOf(`export function ${name}(`);
      expect(start, `${name} 应存在`).toBeGreaterThan(-1);
      const next = source.indexOf('\nexport function ', start + 10);
      return source.slice(start, next < 0 ? source.length : next);
    };
    for (const name of ['reviewMaterials', 'finishReview', 'failReview']) {
      expect(bodyOf(name), `${name} 不应读取 requestId`).not.toMatch(/args\.requestId/);
    }
    expect(bodyOf('beginReview')).toMatch(/args\.requestId/);
  });

  it('tells the model exactly what to send when begin has no requestId', async () => {
    const { call, key } = await mount();
    const result = await call('bookfish_review', { action: 'begin', bookKey: key });
    expect(result.ok).toBe(false);
    // 不能只说 "invalid text"：要说明发什么。
    if (!result.ok) {
      expect(result.error).toMatch(/begin needs requestId/);
      expect(result.error).toMatch(/[A-Za-z0-9:_-]{6,}|ASCII/);
    }
  });

  it('rejects a non-ASCII requestId with a usable message', () => {
    const state = { books: [], reviewJobs: [], reviews: [], paused: false, selected: '' } as unknown as LibraryState;
    expect(() => beginReview(state, { bookKey: 'x', requestId: '评论-1' }, 0)).toThrow(/ASCII/);
  });

  it('lets every non-begin action run without a requestId', async () => {
    const { call, key } = await mount();
    // list / get / materials / finish / fail 都不该因为缺 requestId 而报错。
    const list = await call('bookfish_review', { action: 'list', bookKey: key });
    expect(list.ok).toBe(true);
    const get = await call('bookfish_review', { action: 'get', reviewId: 'nope' });
    expect(get.ok ? true : !/requestId/.test(get.error)).toBe(true);
    const materials = await call('bookfish_review', { action: 'materials', jobId: 'nope', kind: 'ranges' });
    expect(materials.ok ? true : !/requestId/.test(materials.error)).toBe(true);
    const finish = await call('bookfish_review', { action: 'finish', jobId: 'nope', title: 't', text: 'x'.repeat(120), episodeIds: [], evidence: [] });
    expect(finish.ok ? true : !/requestId/.test(finish.error)).toBe(true);
    const fail = await call('bookfish_review', { action: 'fail', jobId: 'nope', reason: 'stop' });
    expect(fail.ok ? true : !/requestId/.test(fail.error)).toBe(true);
  });

  it('refuses to begin on an unfinished book even with a valid requestId', async () => {
    const { call, key } = await mount();
    const result = await call('bookfish_review', { action: 'begin', bookKey: key, requestId: 'review-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/fully|continuously|confirmed/i);
  });
});

describe('review handler contracts that do not depend on the schema', () => {
  const emptyState = () => ({ books: [], reviewJobs: [], reviews: [], paused: false, selected: '' }) as unknown as LibraryState;

  it('materials needs a live job, not a requestId', () => {
    expect(() => reviewMaterials(emptyState(), { kind: 'ranges' }, 0)).toThrow(/stale|paused|expired|cancelled/i);
  });

  it('fail needs a job that exists and is not saved', () => {
    expect(() => failReview(emptyState(), { jobId: 'missing', reason: 'x' })).toThrow(/missing/i);
  });

  it('finish needs a job', () => {
    expect(() => finishReview(emptyState(), { jobId: 'missing' }, 0)).toThrow(/missing/i);
  });
});
