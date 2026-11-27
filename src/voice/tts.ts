import { TtsError, redact, safeMessage } from './errors.ts';

/** Built-in MiMo TTS channel. Only the KEY is user-supplied. */
export const MIMO_TTS = {
  baseUrl: 'https://api.xiaomimimo.com/v1',
  model: 'mimo-v2.5-tts',
  voice: 'mimo_default',
} as const;

export const MAX_TTS_INPUT_CHARS = 500;
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export interface TtsEndpoint {
  apiKey: string;
}

export interface SynthesizeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  attempts?: number;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  maxAudioBytes?: number;
}

/** Basic RIFF/WAVE container check: header plus non-empty fmt and data chunks. */
export function isWav(bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length < 44) return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.toString('ascii', 0, 4) !== 'RIFF' || view.toString('ascii', 8, 12) !== 'WAVE') return false;
  let offset = 12;
  let hasFmt = false;
  let hasData = false;
  while (offset + 8 <= view.length) {
    const id = view.toString('ascii', offset, offset + 4);
    const size = view.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > view.length) return false;
    if (id === 'fmt ' && size >= 16) hasFmt = true;
    if (id === 'data' && size > 0) hasData = true;
    offset = body + size + (size % 2);
  }
  return hasFmt && hasData;
}

function abortReason(signal: AbortSignal | undefined, timeoutSignal: AbortSignal | undefined): TtsError {
  if (signal?.aborted) return new TtsError('aborted', '语音合成已取消');
  if (timeoutSignal?.aborted) return new TtsError('timeout', '语音合成超时，请稍后重试');
  return new TtsError('aborted', '语音合成已取消');
}

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers?.get?.('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) throw new TtsError('invalid_audio', '语音合成响应过大');
  const body = response.body;
  if (!body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new TtsError('invalid_audio', '语音合成响应过大');
    return bytes;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new TtsError('invalid_audio', '语音合成响应过大');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return merged;
}

/** Extract only a short error code/type from a vendor response; never keep its text. */
async function readVendorCode(response: Response): Promise<string> {
  try {
    const raw = await readBounded(response, 8192);
    const json = JSON.parse(Buffer.from(raw).toString('utf8')) as
      { error?: { code?: unknown; type?: unknown }; code?: unknown };
    const value = json?.error?.code ?? json?.error?.type ?? json?.code;
    return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : '';
  } catch {
    return '';
  }
}

function decodeBase64Audio(data: unknown, maxAudioBytes: number): Uint8Array {
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new TtsError('invalid_audio', '语音合成没有返回有效音频数据');
  }
  const bytes = Uint8Array.from(Buffer.from(data, 'base64'));
  if (bytes.byteLength < 44 || bytes.byteLength > maxAudioBytes) throw new TtsError('invalid_audio', '语音合成音频为空或过大');
  if (!isWav(bytes)) throw new TtsError('invalid_audio', '语音合成返回的不是有效 WAV 音频');
  return bytes;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    timer.unref?.();
    const abort = () => { clearTimeout(timer); reject(new TtsError('aborted', '语音合成已取消')); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * POST text to MiMo and return validated WAV bytes. Retries only network errors,
 * 408/429/5xx, up to `attempts`; never retries 4xx auth errors. The message never
 * contains the key or the input text.
 */
export async function synthesize(endpoint: TtsEndpoint, input: string, options: SynthesizeOptions = {}): Promise<Uint8Array> {
  const text = input.trim();
  if (!text) throw new TtsError('config', '没有可朗读的文本');
  if (Array.from(text).length > MAX_TTS_INPUT_CHARS) throw new TtsError('config', '单次语音合成文本过长');
  const apiKey = endpoint.apiKey.trim();
  if (!apiKey) throw new TtsError('config', '尚未填写 MiMo 语音 KEY');

  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = Math.max(1, Math.min(4, options.attempts ?? 3));
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const maxAudioBytes = options.maxAudioBytes ?? MAX_AUDIO_BYTES;
  const timeoutMs = options.timeoutMs ?? 30000;

  let externalSignal: AbortSignal | undefined = options.signal;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (externalSignal?.aborted) throw abortReason(externalSignal, undefined);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await fetchImpl(`${MIMO_TTS.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MIMO_TTS.model,
          messages: [
            { role: 'user', content: '' },
            { role: 'assistant', content: text },
          ],
          audio: { format: 'wav', voice: MIMO_TTS.voice },
        }),
        signal,
      });
    } catch (error) {
      if (externalSignal?.aborted || timeoutSignal.aborted) throw abortReason(externalSignal, timeoutSignal);
      // The key never appears in a network error; keep only a bounded summary.
      const message = safeMessage(error, 200);
      if (attempt < attempts) { await delay(400 * attempt, externalSignal ?? new AbortController().signal); continue; }
      throw new TtsError('network', `语音合成请求未能发出：${message}`);
    }

    if (!response.ok) {
      // Never surface the vendor response body: it can echo input text or account
      // details. Keep only the HTTP status and a bounded machine-readable code.
      const code = await readVendorCode(response);
      const message = `HTTP ${response.status}${code && code !== String(response.status) ? ` (${code})` : ''}`;
      if (retryable(response.status) && attempt < attempts) { await delay(400 * attempt, externalSignal ?? new AbortController().signal); continue; }
      throw new TtsError('http', `语音合成请求失败：${redact(message, apiKey)}`);
    }

    let raw: Uint8Array;
    try {
      raw = await readBounded(response, maxResponseBytes);
    } catch (error) {
      if (error instanceof TtsError) throw error;
      if (externalSignal?.aborted || timeoutSignal.aborted) throw abortReason(externalSignal, timeoutSignal);
      throw new TtsError('invalid_audio', '语音合成响应读取失败');
    }

    let json: unknown;
    try { json = JSON.parse(Buffer.from(raw).toString('utf8')); }
    catch { throw new TtsError('invalid_audio', '语音合成响应不是有效 JSON'); }
    const data = (json as { choices?: Array<{ message?: { audio?: { data?: string } } }> })
      ?.choices?.[0]?.message?.audio?.data;
    return decodeBase64Audio(data, maxAudioBytes);
  }
  throw new TtsError('network', '语音合成重试次数已用完');
}