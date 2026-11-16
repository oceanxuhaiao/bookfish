/**
 * Assemble the exact model-visible context for one A/B arm.
 *
 * The system prompt is rebuilt from the live host's own `/api/prompts/prefix`
 * snapshot, with the BookFish segment swapped for the arm's ENV_PROMPT file, so
 * both arms differ in exactly one variable.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Arm = 'before' | 'after';

export interface PrefixSegment { title: string; sourceKey?: string; text: string }

export interface ArmContext {
  /** Full system prompt exactly as the host assembles it. */
  system: string;
  /** Model-visible tool definitions (name/description/parameters only). */
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>;
  /** Characters of the BookFish env prompt used in this arm. */
  envPromptChars: number;
  /** Characters of the BookFish tool schemas used in this arm. */
  toolChars: number;
}

const HOST_SNAPSHOT = 'E:/项目/桌面宠物/扩展/看书吧！大肥鱼/output/prompt-refactor/host-prefix-before.json';
const HOST_TOOLS = 'E:/项目/桌面宠物/扩展/看书吧！大肥鱼/output/prompt-refactor/host-tool-schemas-before.json';

export interface ArmSources {
  /** Directory whose `src/ENV_PROMPT.md` and `src/tool-schemas.ts` define the arm. */
  srcDir: string;
}

function readJson(path: string): any {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

export function hostSegments(): PrefixSegment[] {
  return readJson(HOST_SNAPSHOT).segments as PrefixSegment[];
}

export function hostTools(): Array<{ name: string; description: string; parameters: unknown; owner?: { id?: string } }> {
  return readJson(HOST_TOOLS).tools;
}

/** Render the system prompt the way Core does: every segment verbatim, in order. */
export function assembleSystem(segments: readonly PrefixSegment[], bookfishEnv: string): string {
  return segments.map((segment) => {
    const text = segment.sourceKey === 'worlds.bookfish.envPrompt' ? bookfishEnv.trim() : segment.text.trim();
    if (!text) return '';
    return `━━━ ${segment.title} ━━━\n${text}`;
  }).filter(Boolean).join('\n\n');
}

export async function armContext(sources: ArmSources, options: { tokenTools?: boolean } = {}): Promise<ArmContext> {
  const envPrompt = readFileSync(join(sources.srcDir, 'ENV_PROMPT.md'), 'utf8');
  const mod = await import(pathToFileURL(resolve(sources.srcDir, 'tool-schemas.ts')).href);
  const decls = mod.BOOKFISH_TOOL_DECLS as ReadonlyArray<{ name: string; description: string; parameters: unknown }>;
  const declared = new Set(decls.map((decl) => decl.name));
  const bookfishTools = JSON.stringify(decls.map((decl) => ({ name: decl.name, description: decl.description, parameters: decl.parameters })));

  const others = hostTools()
    .filter((tool) => !declared.has(tool.name))
    .map((tool) => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  const mine = decls.map((decl) => ({ type: 'function' as const, function: { name: decl.name, description: decl.description, parameters: decl.parameters } }));

  return {
    system: assembleSystem(hostSegments(), envPrompt),
    tools: [...others, ...mine],
    envPromptChars: envPrompt.length,
    toolChars: bookfishTools.length,
  };
}
