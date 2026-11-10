/**
 * Signed update manifest fetch.
 *
 * The signature protects the whole document; individual releases still need a
 * pinned archive digest, which `requireTrustedManifest` enforces. Without a
 * configured public key, upgrade checks stay disabled rather than falling back
 * to an unauthenticated manifest.
 */
import { createPublicKey, verify } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { assertAllowedUrl } from './download.ts';
import { requireTrustedManifest } from './manifest.ts';
import type { TrustedRuntimeManifest } from './types.ts';

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

function fetchSmall(url: URL, allowedHosts: readonly string[], signal?: AbortSignal, allowInsecureLoopback?: boolean): Promise<{ url: URL; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let current = url;
    let redirects = 0;
    const go = (target: URL): void => {
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(target, { method: 'GET', timeout: 20_000, headers: { 'user-agent': 'bookfish-runtime-update' } }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && typeof response.headers.location === 'string') {
          response.resume();
          if (++redirects > 4) return reject(new Error('更新清单重定向次数过多'));
          try { current = new URL(response.headers.location, target); } catch { return reject(new Error('更新清单重定向无效')); }
          void assertAllowedUrl(current.toString(), { allowedHosts, allowInsecureLoopback }).then(go, reject);
          return;
        }
        if (status !== 200) { response.resume(); return reject(new Error(`更新清单请求失败（HTTP ${status}）`)); }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_MANIFEST_BYTES) { response.destroy(); reject(new Error('更新清单过大')); return; }
          chunks.push(chunk);
        });
        response.on('end', () => resolve({ url: current, body: Buffer.concat(chunks) }));
        response.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(new Error('更新清单请求超时')); });
      req.on('error', reject);
      signal?.addEventListener('abort', () => req.destroy(new Error('cancelled')), { once: true });
      req.end();
    };
    go(current);
  });
}

export async function fetchSignedUpdate(options: { url: string; publicKey: string; allowedHosts: readonly string[]; signal?: AbortSignal; allowInsecureLoopback?: boolean }): Promise<TrustedRuntimeManifest[]> {
  const manifestUrl = await assertAllowedUrl(options.url, { allowedHosts: options.allowedHosts, allowInsecureLoopback: options.allowInsecureLoopback });
  const [document, signature] = await Promise.all([
    fetchSmall(manifestUrl, options.allowedHosts, options.signal, options.allowInsecureLoopback),
    fetchSmall(new URL(`${manifestUrl.toString()}.sig`), options.allowedHosts, options.signal, options.allowInsecureLoopback),
  ]);
  let key;
  try { key = createPublicKey({ key: Buffer.from(options.publicKey, 'base64'), format: 'der', type: 'spki' }); }
  catch { throw new Error('更新公钥格式无效'); }
  if (!verify(null, document.body, key, signature.body)) throw new Error('更新清单签名无效');
  let parsed: unknown;
  try { parsed = JSON.parse(document.body.toString('utf8')); } catch { throw new Error('更新清单不是有效 JSON'); }
  const value = parsed as { schema?: unknown; releases?: unknown };
  if (value?.schema !== 1 || !Array.isArray(value.releases) || !value.releases.length || value.releases.length > 32) throw new Error('更新清单结构无效');
  return value.releases.map((release) => {
    const manifest = requireTrustedManifest(release);
    if (manifest.platform !== 'win32' || manifest.arch !== 'x64') throw new Error('更新清单包含不支持的平台');
    return manifest;
  });
}
