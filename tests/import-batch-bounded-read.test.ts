import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRange } from '../src/import-batches.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bookfish-range-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('readRange reads a bounded window, never the whole file', () => {
  it('returns exactly the requested bytes at any offset', () => {
    const file = join(dir, 'data.bin');
    const pattern = Buffer.alloc(4096);
    for (let index = 0; index < pattern.length; index += 1) pattern[index] = index % 251;
    writeFileSync(file, pattern);
    for (const [offset, length] of [[0, 64], [100, 256], [4000, 96], [2048, 2048]] as const) {
      const range = readRange(file, offset, length);
      expect(range.length).toBe(length);
      expect(range.equals(pattern.subarray(offset, offset + length))).toBe(true);
    }
  });

  it('a short read means the file is shorter than the request', () => {
    const file = join(dir, 'short.bin');
    writeFileSync(file, Buffer.alloc(100, 7));
    const range = readRange(file, 60, 80);
    expect(range.length).toBe(40);
    expect(range.every((byte) => byte === 7)).toBe(true);
    const beyond = readRange(file, 500, 10);
    expect(beyond.length).toBe(0);
  });
});

describe('chunk replay stays bounded on a large staged file', () => {
  /**
   * A 64 MiB sparse file: the declared size is what the staging logic sees, but
   * only a few real blocks exist on disk. A whole-file read would pull 64 MiB
   * into memory; the bounded replay must not care about the file's total size.
   */
  const sparseFile = (bytes: number, seed: Buffer): string => {
    const file = join(dir, 'large.bin');
    const fd = openSync(file, 'w');
    try {
      writeSync(fd, seed, 0, seed.length, 0);
      ftruncateSync(fd, bytes);
    } finally { closeSync(fd); }
    return file;
  };

  it('reads a 256 KiB window out of a 64 MiB file without loading it all', () => {
    const seed = Buffer.alloc(256 * 1024, 0x5a);
    const file = sparseFile(64 * 1024 * 1024, seed);
    expect(statSync(file).size).toBe(64 * 1024 * 1024);
    // Reading at the very end, where the sparse tail begins.
    const tail = readRange(file, 64 * 1024 * 1024 - 1024, 1024);
    expect(tail.length).toBe(1024);
    expect(tail.every((byte) => byte === 0)).toBe(true);
    // And at the seeded head.
    const head = readRange(file, 0, 4096);
    expect(head.every((byte) => byte === 0x5a)).toBe(true);
  });

  it('the batch module never goes back to whole-file reads', () => {
    // A source-level regression guard: the whole-file `readFileSync` buffer and
    // the copy fallback were removed precisely because they put up to 512 MiB
    // in memory. If this fails, someone reintroduced an unbounded path.
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'import-batches.ts'), 'utf8');
    expect(source).not.toMatch(/\breadFileSync\b/u);
    expect(source).not.toMatch(/\bcopyThenUnlink\b/u);
    // The bounded reader is what the replay paths use.
    expect(source).toMatch(/\breadRange\(file,/u);
    expect(source).not.toMatch(/Buffer\.allocUnsafe\(0\)/u);
  });

  it('a missing file throws instead of returning an empty buffer', () => {
    // Boundary contract: a vanished staging file is an error, never "zero
    // bytes read" — the caller must not mistake absence for content.
    expect(() => readRange(join(dir, 'nowhere.bin'), 0, 4)).toThrow();
  });
});

describe('replay correctness on a large staged file via the real chunk path', () => {
  it('a small chunk of a 64 MiB staged ZIP replays idempotently', async () => {
    const { Library } = await import('../src/library.ts');
    const { ImportBatches } = await import('../src/import-batches.ts');
    const lib = new Library({ dataDir: dir, now: () => 0 });
    lib.open();
    const batches = new ImportBatches(lib, join(dir, 'transfers'), { now: () => 0 });
    try {
      const batch = batches.create({ source: 'zip' });
      const chunk = Buffer.alloc(256 * 1024, 0xab);
      const encoded = chunk.toString('base64');
      // Declare a 64 MiB archive, upload only the first chunk.
      batches.zipBegin(batch.id, { name: 'big.zip', size: 64 * 1024 * 1024 });
      batches.zipChunk(batch.id, 0, encoded);
      // Replay the same chunk: byte-identical, accepted without a full read.
      expect(batches.zipChunk(batch.id, 0, encoded)).toMatchObject({ offset: 256 * 1024, replayed: true });
      // A different chunk at the same offset: refused.
      const other = Buffer.alloc(256 * 1024, 0xcd);
      expect(() => batches.zipChunk(batch.id, 0, other.toString('base64'))).toThrow('replay does not match');
      // Skipping ahead is refused before any read happens.
      expect(() => batches.zipChunk(batch.id, 512 * 1024, encoded)).toThrow('skipped bytes');
    } finally {
      await batches.shutdown();
      lib.close();
    }
  });
});
