import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createRuntimeFixture } from './helpers/runtime-fixture.ts';
import { fetchSignedUpdate } from '../src/novel-runtime/update.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function keypair(): { publicKey: string; privateKey: import('node:crypto').KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey };
}

describe('signed runtime update manifest', () => {
  it('accepts a correctly signed document and rejects a tampered one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bookfish-update-'));
    try {
      const fixture = await createRuntimeFixture(join(dir, 'fixture'));
      const { publicKey, privateKey } = keypair();
      const document = Buffer.from(JSON.stringify({ schema: 1, releases: [fixture.manifest] }));
      const signature = sign(null, document, privateKey);
      let tamper = false;
      const server = createServer((request, response) => {
        if (request.url === '/latest.json') { response.writeHead(200).end(tamper ? Buffer.from(JSON.stringify({ schema: 1, releases: [{ ...fixture.manifest, runtimeVersion: 'evil' }] })) : document); return; }
        if (request.url === '/latest.json.sig') { response.writeHead(200).end(signature); return; }
        response.writeHead(404).end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      try {
        const base = `http://127.0.0.1:${port}/latest.json`;
        const releases = await fetchSignedUpdate({ url: base, publicKey, allowedHosts: ['127.0.0.1'], allowInsecureLoopback: true });
        expect(releases[0]!.runtimeId).toBe(fixture.manifest.runtimeId);
        tamper = true;
        await expect(fetchSignedUpdate({ url: base, publicKey, allowedHosts: ['127.0.0.1'], allowInsecureLoopback: true })).rejects.toThrow(/签名无效/);
      } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses an update host that is not in the trusted list', async () => {
    const { publicKey } = keypair();
    await expect(fetchSignedUpdate({ url: 'https://updates.example.test/latest.json', publicKey, allowedHosts: ['runtime.example.test'] })).rejects.toThrow(/不在受信列表/);
  });
});
