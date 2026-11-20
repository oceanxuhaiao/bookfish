import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BOOKFISH } from '../src/definition.ts';

let scratchDir: string;
beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'bookfish-txt-tool-')); });
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

function create() {
  const ctx = fakeWorldContext(BOOKFISH, { scratchDir });
  ctx.persist({ automaticReading: false, realRoutineEnabled: false, readingBatchSegments: 1 });
  return { ctx, world: BOOKFISH.create(ctx) };
}

type World = ReturnType<typeof create>['world'];
async function call(world: World, args: Record<string, unknown>): Promise<unknown> {
  const tool = world.tools().find((entry) => entry.name === 'bookfish_import_txt')!;
  const result = await tool.handler(args, {} as ToolCallContext);
  return JSON.parse(typeof result === 'string' ? result : result.text);
}

describe('bookfish_import_txt tool surface', () => {
  it('registers one tool with the documented actions and keeps its prompt guidance', () => {
    const { world } = create();
    const tool = world.tools().find((entry) => entry.name === 'bookfish_import_txt');
    expect(tool).toBeTruthy();
    expect(tool!.description).toContain('discover');
    expect(tool!.description).toContain('repair');
    const actions = (tool!.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum;
    expect(actions).toEqual(['discover', 'import', 'status', 'retry', 'repair', 'cancel']);

    const described = BOOKFISH.describe?.tools.find((entry) => entry.name === 'bookfish_import_txt');
    expect(described?.summary).toBeTruthy();
    const prompt = readFileSync(join(process.cwd(), 'src', 'ENV_PROMPT.md'), 'utf8');
    expect(prompt).toContain('bookfish_import_txt');
    expect(prompt).toContain('不可信');
  });

  it('stays off by default and reports that in world status', async () => {
    const { world } = create();
    const status = await world.tools()[0]!.handler({}, {} as ToolCallContext);
    const parsed = JSON.parse(typeof status === 'string' ? status : status.text) as { txtFiles: { enabled: boolean; browserConfigured: boolean; active: number } };
    expect(parsed.txtFiles).toMatchObject({ enabled: false, browserConfigured: false, active: 0 });
    expect(await call(world, { action: 'status' })).toEqual([]);
  });

  it('refuses to discover while the feature is disabled', async () => {
    const { world } = create();
    await expect(call(world, { action: 'discover', pageUrl: 'https://example.com/book', title: '海风' }))
      .rejects.toThrow(/disabled/iu);
  });

  it('validates the action and the required identifiers', async () => {
    const { world } = create();
    await expect(call(world, { action: 'download' })).rejects.toThrow(/action must be/iu);
    await expect(call(world, { action: 'import' })).rejects.toThrow(/import needs fileUrl/iu);
    await expect(call(world, { action: 'retry' })).rejects.toThrow(/taskId/iu);
    await expect(call(world, { action: 'status', taskId: 'nope' })).rejects.toThrow(/Unknown acquisition task/iu);
  });
});
