import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOOKFISH_TOOL_DECLS } from '../src/tool-schemas.ts';

const root = join(import.meta.dirname, '..');
const prompt = readFileSync(join(root, 'src', 'ENV_PROMPT.md'), 'utf8');
const tools = JSON.stringify(BOOKFISH_TOOL_DECLS);

describe('resident context budget', () => {
  it('keeps the model-visible protocol and tool surface bounded', () => {
    expect(BOOKFISH_TOOL_DECLS).toHaveLength(15);
    expect(prompt.length).toBeLessThan(10_500);
    expect(tools.length).toBeLessThan(13_000);
    expect(prompt.length + tools.length).toBeLessThan(23_500);
  });

  it('has an on-demand protocol document for every help topic', () => {
    for (const topic of ['reading', 'journal', 'retrieval', 'sharing', 'review', 'selection', 'discussion']) {
      const text = readFileSync(join(root, 'src', 'protocol', `${topic}.md`), 'utf8');
      expect(text.length).toBeGreaterThan(200);
    }
  });
});
