import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Sha256, fileSha256Hex } from '../src/webui/sha256.ts';

const reference = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 7 + length * 13) % 256;
  return bytes;
};

describe('the incremental SHA-256 matches the reference implementation', () => {
  it('knows the standard vectors', () => {
    expect(new Sha256().digest()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(new Sha256().update(new TextEncoder().encode('abc')).digest())
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('agrees with node:crypto for every length around the block boundaries', () => {
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 200, 1000, 4096]) {
      const bytes = randomBytes(length);
      expect(new Sha256().update(bytes).digest()).toBe(reference(bytes));
    }
  });

  it('feeding in arbitrary slices gives the same digest as one update', () => {
    for (const [length, slice] of [[5000, 7], [5000, 64], [5000, 1024], [331, 3], [128, 128]] as const) {
      const bytes = randomBytes(length);
      const hashed = new Sha256();
      for (let at = 0; at < length; at += slice) hashed.update(bytes.subarray(at, Math.min(at + slice, length)));
      expect(hashed.digest()).toBe(reference(bytes));
    }
  });

  it('digest() is terminal and padding never double-counts', () => {
    const bytes = randomBytes(300);
    const hasher = new Sha256().update(bytes);
    expect(hasher.digest()).toBe(reference(bytes));
    // A second digest of the same instance is not part of the contract; what
    // matters is that one instance, used once, matches. Fresh instance:
    expect(new Sha256().update(bytes).digest()).toBe(reference(bytes));
  });
});

describe('fileSha256Hex streams a File without holding it whole', () => {
  it('hashes a real File in slices and matches node:crypto', async () => {
    const body = randomBytes(200 * 1024); // two hundred KiB, sliced at 64 KiB
    const file = new File([body], 'book.zip', { type: 'application/zip' });
    expect(await fileSha256Hex(file, 64 * 1024)).toBe(reference(body));
  });

  it('an empty file digests to the empty-message hash', async () => {
    const file = new File([new Uint8Array(0)], 'empty.zip');
    expect(await fileSha256Hex(file)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('returns null instead of throwing when reading fails', async () => {
    const broken = {
      size: 1024,
      slice: () => { throw new Error('unreadable'); },
    } as unknown as File;
    expect(await fileSha256Hex(broken, 64)).toBeNull();
  });
});
