import { describe, expect, it, vi } from 'vitest';
import { TtsError } from '../src/voice/errors.ts';
import { isWav, MAX_AUDIO_BYTES, MAX_RESPONSE_BYTES, synthesize } from '../src/voice/tts.ts';
import { makeWav, wavBase64 } from './helpers/voice-fixtures.ts';

const KEY = 'test-key-1234567890';

function okResponse(data = wavBase64()): Response {
  return new Response(JSON.stringify({ choices: [{ message: { audio: { data } } }] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}
const asFetch = (fn: ReturnType<typeof vi.fn>) => fn as unknown as typeof fetch;

describe('MiMo TTS client', () => {
  it('returns validated WAV bytes and never puts the KEY in the result', async () => {
    const mock = vi.fn(async () => okResponse());
    const bytes = await synthesize({ apiKey: KEY }, '海边的风。', { fetchImpl: asFetch(mock) });
    expect(isWav(bytes)).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
    const call = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://api.xiaomimimo.com/v1/chat/completions');
    expect((call[1].headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(String(call[1].body)).toContain('海边的风。');
    expect(String(call[1].body)).not.toContain('test-key');
  });

  it('rejects an empty key before any request', async () => {
    const mock = vi.fn(async () => okResponse());
    await expect(synthesize({ apiKey: '  ' }, '文本', { fetchImpl: asFetch(mock) }))
      .rejects.toMatchObject({ code: 'config' });
    expect(mock).not.toHaveBeenCalled();
  });

  it('does not retry a 401 and never echoes the KEY', async () => {
    const mock = vi.fn(async () => new Response(`bad key ${KEY}`, { status: 401 }));
    let caught: unknown;
    try { await synthesize({ apiKey: KEY }, '文本', { fetchImpl: asFetch(mock) }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(TtsError);
    expect((caught as TtsError).code).toBe('http');
    expect((caught as Error).message).toContain('HTTP 401');
    expect((caught as Error).message).not.toContain(KEY);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx a bounded number of times', async () => {
    const mock = vi.fn(async () => new Response('temporary', { status: 503 }));
    await expect(synthesize({ apiKey: KEY }, '文本', { fetchImpl: asFetch(mock), attempts: 3 }))
      .rejects.toMatchObject({ code: 'http' });
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('recovers after a transient 500', async () => {
    let calls = 0;
    const mock = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? new Response('temporary', { status: 500 }) : okResponse();
    });
    const bytes = await synthesize({ apiKey: KEY }, '文本', { fetchImpl: asFetch(mock), attempts: 3 });
    expect(isWav(bytes)).toBe(true);
    expect(calls).toBe(2);
  });

  it('classifies timeout and external cancellation separately', async () => {
    const hanging = (_input: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) { reject(signal.reason); return; }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    await expect(synthesize({ apiKey: KEY }, '文本', { fetchImpl: hanging as unknown as typeof fetch, timeoutMs: 20, attempts: 1 }))
      .rejects.toMatchObject({ code: 'timeout' });
    const controller = new AbortController();
    controller.abort();
    await expect(synthesize({ apiKey: KEY }, '文本', { fetchImpl: hanging as unknown as typeof fetch, signal: controller.signal, attempts: 1 }))
      .rejects.toMatchObject({ code: 'aborted' });
  });

  it('rejects malformed base64, non-WAV audio and oversized responses', async () => {
    const invalid = vi.fn(async () => okResponse('!!!!'));
    await expect(synthesize({ apiKey: KEY }, '文本', { fetchImpl: asFetch(invalid) }))
      .rejects.toMatchObject({ code: 'invalid_audio' });
    const notWav = Buffer.from('not a wav at all, definitely not audio').toString('base64');
    const wrong = vi.fn(async () => okResponse(notWav));
    await expect(synthesize({ apiKey: KEY }, '文本', { fetchImpl: asFetch(wrong) }))
      .rejects.toMatchObject({ code: 'invalid_audio' });
    const big = vi.fn(async () => okResponse('A'.repeat(200)));
    await expect(synthesize({ apiKey: KEY }, '文本', { fetchImpl: asFetch(big), maxAudioBytes: 100 }))
      .rejects.toMatchObject({ code: 'invalid_audio' });
    const large = vi.fn(async () => okResponse());
    await expect(synthesize({ apiKey: KEY }, '文本', { fetchImpl: asFetch(large), maxResponseBytes: 10 }))
      .rejects.toMatchObject({ code: 'invalid_audio' });
  });

  it('bounds are explicit and a valid WAV is accepted', () => {
    expect(MAX_AUDIO_BYTES).toBeGreaterThan(1024);
    expect(MAX_RESPONSE_BYTES).toBeGreaterThan(MAX_AUDIO_BYTES);
    expect(isWav(makeWav())).toBe(true);
    expect(isWav(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});