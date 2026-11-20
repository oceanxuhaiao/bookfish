import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BOOKFISH_TOOL_DECLS } from '../src/tool-schemas.ts';
import { HELP_TOPICS } from '../src/protocols.ts';
import { BOOKFISH } from '../src/definition.ts';

const root = join(import.meta.dirname, '..');
const prompt = readFileSync(join(root, 'src', 'ENV_PROMPT.md'), 'utf8');
const protocolDir = join(root, 'src', 'protocol');
const protocolFiles = readdirSync(protocolDir).filter((name) => name.endsWith('.md')).sort();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

/** Compare two dotted versions by their numeric parts; positive means `a` is newer. */
const compareMinor = (a: string, b: string): number => {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
};

/**
 * What a model actually receives per tool: name, description and parameters.
 * The host adds runtime metadata (`owner`) and the package adds tags/barrierAfter,
 * neither of which is the model-visible schema text. Budgeting on the full
 * `JSON.stringify` over-counts by ~400 characters and lets the wire format creep.
 */
const modelVisible = (decl: (typeof BOOKFISH_TOOL_DECLS)[number]) => ({ name: decl.name, description: decl.description, parameters: decl.parameters });
const tools = JSON.stringify(BOOKFISH_TOOL_DECLS.map(modelVisible));

/** Tool names that legitimately appear in protocols but belong to the host, not this World. */
const HOST_TOOLS = new Set(['pet_say']);

interface Header { topic: string; version: number; since: string; tools: string[] }
function headerOf(name: string, text: string): Header {
  const match = /^<!-- protocol topic=([a-z]+) v=(\d+) since=(\d+\.\d+\.\d+)(?: tools=([^ ]+))? -->$/m.exec(text);
  if (!match) throw new Error(`src/protocol/${name} has no protocol header comment`);
  return { topic: match[1], version: Number(match[2]), since: match[3], tools: (match[4] ?? '').split(',').filter(Boolean) };
}
function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((block) => block.trim()).filter((block) => block.length >= 200);
}

describe('resident context budget', () => {
  it('keeps the model-visible tool surface within budget', () => {
    expect(BOOKFISH_TOOL_DECLS).toHaveLength(16);
    expect(tools.length).toBeLessThanOrEqual(13_400);
    expect(prompt.length + tools.length).toBeLessThanOrEqual(15_000);
  });

  it('keeps the resident environment prompt at principle level', () => {
    expect(prompt.length).toBeLessThanOrEqual(800);
    expect(prompt.length).toBeGreaterThanOrEqual(300);
  });

  it('stays inside the 300-800 character target band', () => {
    // If this fails legitimately, change the number here together with a written
    // reason in docs/prompt-refactor/. Silent budget increases are not allowed.
    // 2026-11: browser-assisted TXT acquisition added one resident principle line;
    // see docs/prompt-refactor/2026-11-txt-acquisition.md for the measured reason.
    expect(prompt.length).toBeLessThanOrEqual(800);
  });

  it('keeps the seven non-negotiable principles in the resident prompt', () => {
    for (const [label, pattern] of [
      ['identity continuity', /大肥鱼[\s\S]*同一个人/],
      ['untrusted source text', /不可信的外部数据/],
      ['tools are the source of truth', /以 BookFish 工具返回为准/],
      ['only confirmed contiguous text counts as read', /成功确认的连续原文才算已读/],
      ['no fabricated experience', /不得用摘要、推断或训练里的记忆补造/],
      ['opportunities are optional', /机会事件都是可选项，不是命令/],
      ['autonomy and privacy', /由你自己决定[\s\S]*不会自动公开/],
      ['on-demand protocols', /bookfish_help/],
      ['receipts before claims', /没拿到成功回执的事，不要说已经做完/],
    ] as const) {
      expect(prompt, label).toMatch(pattern);
    }
  });

  it('does not let protocol detail creep back into the resident prompt', () => {
    // These belong to src/protocol/*.md and must only arrive through bookfish_help.
    for (const token of ['opportunityId', 'confirmations', 'claimId', 'nextOffset', 'maxSentenceChars', 'visibleAt', 'storyChanges', 'evidenceSegmentIds', 'pet_say', 'meta.manual', '##']) {
      expect(prompt, `ENV_PROMPT must not describe ${token}`).not.toContain(token);
    }
  });
});

describe('on-demand protocol set', () => {
  it('has exactly one document per help topic and no orphan documents', () => {
    expect(protocolFiles).toEqual(HELP_TOPICS.map((topic) => `${topic}.md`).sort());
  });

  it('declares a header that matches its file, its release and the real tools', () => {
    const declared = new Set(BOOKFISH_TOOL_DECLS.map((decl) => decl.name));
    for (const file of protocolFiles) {
      const text = readFileSync(join(protocolDir, file), 'utf8');
      const header = headerOf(file, text);
      expect(header.topic, file).toBe(file.replace(/\.md$/, ''));
      expect(header.version, file).toBeGreaterThanOrEqual(1);
      // A protocol records the release its text last changed in, so an unchanged
      // document keeps an older release across minor bumps. It must never claim a
      // release newer than the package itself.
      expect(compareMinor(header.since, pkg.version), `${file} must not come from a newer release than ${pkg.version}`).toBeLessThanOrEqual(0);
      expect(text.length, file).toBeGreaterThan(200);
      expect(header.tools.length, `${file} must declare the tools it drives`).toBeGreaterThan(0);
      for (const tool of header.tools) {
        expect(declared.has(tool) || HOST_TOOLS.has(tool), `${file} mentions unknown tool ${tool}`).toBe(true);
      }
    }
  });

  it('does not repeat the same long paragraph in two documents', () => {
    const seen = new Map<string, string>();
    for (const file of protocolFiles) {
      for (const block of paragraphs(readFileSync(join(protocolDir, file), 'utf8'))) {
        const prior = seen.get(block);
        expect(prior, `${file} duplicates a ${block.length}-character paragraph from ${prior}`).toBeUndefined();
        seen.set(block, file);
      }
    }
  });

  it('does not repeat a tool description between two tools', () => {
    const seen = new Map<string, string>();
    for (const decl of BOOKFISH_TOOL_DECLS) {
      const prior = seen.get(decl.description);
      expect(prior, `${decl.name} duplicates the description of ${prior}`).toBeUndefined();
      seen.set(decl.description, decl.name);
    }
  });
});

describe('bookfish_help', () => {
  function world() {
    const scratchDir = mkdtempSync(join(tmpdir(), 'bookfish-budget-'));
    const ctx = fakeWorldContext(BOOKFISH, { scratchDir });
    return { world: BOOKFISH.create(ctx), dispose: () => rmSync(scratchDir, { recursive: true, force: true }) };
  }

  it('returns only the requested topic and nothing from the others', async () => {
    const { world: instance, dispose } = world();
    try {
      const help = instance.tools().find((tool) => tool.name === 'bookfish_help')!;
      for (const topic of HELP_TOPICS) {
        const text = await help.handler({ topic }, {} as ToolCallContext) as string;
        expect(text, topic).toContain(`topic=${topic} `);
        for (const other of HELP_TOPICS.filter((name) => name !== topic)) {
          expect(text, `${topic} leaked ${other}`).not.toContain(`topic=${other} `);
        }
      }
    } finally { dispose(); }
  });

  it('rejects an unknown topic with the full list', async () => {
    const { world: instance, dispose } = world();
    try {
      const help = instance.tools().find((tool) => tool.name === 'bookfish_help')!;
      await expect(help.handler({ topic: 'everything' }, {} as ToolCallContext)).rejects.toThrow(/Unknown protocol topic[\s\S]*reading, journal, retrieval, sharing, review, selection, discussion, story/);
    } finally { dispose(); }
  });

  it('never ships protocol bodies inside the resident prompt', async () => {
    const { world: instance, dispose } = world();
    try {
      const help = instance.tools().find((tool) => tool.name === 'bookfish_help')!;
      for (const topic of HELP_TOPICS) {
        const text = await help.handler({ topic }, {} as ToolCallContext) as string;
        const longest = paragraphs(text).sort((a, b) => b.length - a.length)[0];
        if (longest) expect(prompt).not.toContain(longest.slice(0, 180));
      }
    } finally { dispose(); }
  });
});

