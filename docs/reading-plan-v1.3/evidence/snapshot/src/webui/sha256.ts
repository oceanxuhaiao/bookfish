/**
 * Minimal incremental SHA-256 for the browser side.
 *
 * `crypto.subtle.digest()` needs the whole message as one buffer, so a large
 * archive (>64 MiB, up to 512 MiB) would have to be fully loaded to claim its
 * digest up front. This class absorbs 1 MiB slices instead: the memory cost is
 * one block regardless of file size, and the digest is identical by definition.
 *
 * Verified against `crypto.createHash('sha256')` byte-for-byte in the tests.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private held = 0;
  private length = 0;

  update(bytes: Uint8Array): this {
    this.length += bytes.length;
    this.absorb(bytes);
    return this;
  }

  /** Feed bytes without counting them (padding uses this for its own tail). */
  private absorb(bytes: Uint8Array): void {
    let at = 0;
    if (this.held > 0) {
      const take = Math.min(64 - this.held, bytes.length);
      this.block.set(bytes.subarray(0, take), this.held);
      this.held += take;
      at = take;
      if (this.held === 64) { this.compress(this.block); this.held = 0; }
    }
    while (at + 64 <= bytes.length) {
      this.compress(bytes.subarray(at, at + 64));
      at += 64;
    }
    if (at < bytes.length) {
      this.block.set(bytes.subarray(at), 0);
      this.held = bytes.length - at;
    }
  }

  digest(): string {
    const bits = new Uint8Array(8);
    new DataView(bits.buffer).setBigUint64(0, BigInt(this.length) * 8n);
    this.absorb(Uint8Array.of(0x80));
    const zeroRun = (56 - this.held + 64) % 64;
    if (zeroRun > 0) this.absorb(new Uint8Array(zeroRun));
    this.absorb(bits);
    let hex = '';
    for (const word of this.state) hex += word.toString(16).padStart(8, '0');
    return hex;
  }

  private compress(chunk: Uint8Array): void {
    const view = new DataView(chunk.buffer, chunk.byteOffset, 64);
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(i * 4);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]!, y = w[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = this.state[0]!, b = this.state[1]!, c = this.state[2]!, d = this.state[3]!;
    let e = this.state[4]!, f = this.state[5]!, g = this.state[6]!, h = this.state[7]!;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    this.state[0] = (this.state[0]! + a) >>> 0;
    this.state[1] = (this.state[1]! + b) >>> 0;
    this.state[2] = (this.state[2]! + c) >>> 0;
    this.state[3] = (this.state[3]! + d) >>> 0;
    this.state[4] = (this.state[4]! + e) >>> 0;
    this.state[5] = (this.state[5]! + f) >>> 0;
    this.state[6] = (this.state[6]! + g) >>> 0;
    this.state[7] = (this.state[7]! + h) >>> 0;
  }
}

/**
 * SHA-256 of a picked File, streamed in 1 MiB slices. Never holds more than one
 * slice in memory, so a 512 MiB archive costs the same as a 1 MiB one. Returns
 * null only when reading the file fails; a null claim is simply omitted.
 */
export async function fileSha256Hex(file: File, sliceBytes = 1024 * 1024): Promise<string | null> {
  try {
    const hasher = new Sha256();
    for (let offset = 0; offset < file.size; offset += sliceBytes) {
      hasher.update(new Uint8Array(await file.slice(offset, offset + sliceBytes).arrayBuffer()));
    }
    return hasher.digest();
  } catch {
    return null;
  }
}
