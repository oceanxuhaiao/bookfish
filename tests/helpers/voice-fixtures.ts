/** Deterministic WAV and async helpers for the voice tests. */

export function makeWav(durationMs = 40, sampleRate = 8000): Uint8Array {
  const data = Math.max(1, Math.round(sampleRate * durationMs / 1000));
  const bytes = Buffer.alloc(44 + data);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + data, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(data, 40);
  bytes.fill(128, 44);
  return new Uint8Array(bytes);
}

export function wavBase64(durationMs = 40): string {
  return Buffer.from(makeWav(durationMs)).toString('base64');
}

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}