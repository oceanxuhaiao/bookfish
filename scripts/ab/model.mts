/** Minimal chat client for the two real models used by the prompt A/B. */

export interface ChatTool { type: 'function'; function: { name: string; description: string; parameters: unknown } }
export interface ToolCall { name: string; arguments: Record<string, unknown> }
export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  promptTokens: number;
  completionTokens: number;
  elapsedMs: number;
  raw: unknown;
}
export interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_name?: string; tool_call_id?: string; tool_calls?: any[] }

const OLLAMA = 'http://127.0.0.1:11434/api/chat';

export async function ollamaChat(model: string, messages: ChatMessage[], tools: readonly ChatTool[], options: { numCtx?: number; temperature?: number } = {}): Promise<ChatResult> {
  const started = Date.now();
  const payload: Record<string, unknown> = {
    model,
    messages: messages.map((message) => message.role === 'tool'
      ? { role: 'tool', content: message.content, tool_name: message.tool_name }
      : { role: message.role, content: message.content }),
    stream: false,
    options: { temperature: options.temperature ?? 0, num_ctx: options.numCtx ?? 40960, num_predict: 700 },
  };
  if (tools.length) payload.tools = tools;
  const response = await fetch(OLLAMA, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`ollama ${response.status}: ${(await response.text()).slice(0, 400)}`);
  const body = await response.json() as any;
  const message = body.message ?? {};
  const calls: ToolCall[] = (message.tool_calls ?? []).map((call: any) => ({
    name: String(call.function?.name ?? ''),
    arguments: typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments) : (call.function?.arguments ?? {}),
  }));
  return {
    text: String(message.content ?? ''),
    toolCalls: calls,
    promptTokens: Number(body.prompt_eval_count ?? 0),
    completionTokens: Number(body.eval_count ?? 0),
    elapsedMs: Date.now() - started,
    raw: body,
  };
}

/** DeepSeek's OpenAI-compatible endpoint; the key comes from the deployment's provider .env. */
export async function deepseekChat(key: string, model: string, messages: ChatMessage[], tools: readonly ChatTool[], options: { maxTokens?: number } = {}): Promise<ChatResult> {
  const started = Date.now();
  const payload: Record<string, unknown> = {
    model,
    messages: messages.map((message) => ({ ...message })),
    temperature: 0,
    max_tokens: options.maxTokens ?? 700,
    stream: false,
  };
  if (tools.length) payload.tools = tools;
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(payload),
  });
  const body = await response.json() as any;
  if (!response.ok) throw new Error(`deepseek ${response.status}: ${JSON.stringify(body).slice(0, 400)}`);
  const message = body.choices?.[0]?.message ?? {};
  const calls: ToolCall[] = (message.tool_calls ?? []).map((call: any) => ({
    name: String(call.function?.name ?? ''),
    arguments: (() => { try { return JSON.parse(call.function?.arguments ?? '{}'); } catch { return {}; } })(),
  }));
  return {
    text: String(message.content ?? ''),
    toolCalls: calls,
    promptTokens: Number(body.usage?.prompt_tokens ?? 0),
    completionTokens: Number(body.usage?.completion_tokens ?? 0),
    elapsedMs: Date.now() - started,
    raw: body,
  };
}
