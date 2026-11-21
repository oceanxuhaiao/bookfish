import { describe, expect, it } from 'vitest';
import * as yauzl from 'yauzl';
describe('bundled ZIP parser NTFS timestamp regression', () => {
  it.each([4, 7, 9])('does not read past a malformed %i-byte NTFS extra field', size => {
    const entry = new yauzl.Entry() as yauzl.Entry & { getLastModDate(): Date };
    entry.extraFields = [{ id: 10, data: Buffer.alloc(size) }]; entry.lastModFileDate = 0; entry.lastModFileTime = 0;
    expect(() => entry.getLastModDate()).not.toThrow();
  });
});
