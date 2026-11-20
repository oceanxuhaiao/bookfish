import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { checkUrl, type HostResolver } from './url-policy.ts';

/** Validate all answers and give the socket only one approved address; no automatic redirect or proxy. */
export async function fetchPinned(raw: string, options: { allowNetwork: boolean; networkAllowed?: () => boolean; resolve?: HostResolver; signal: AbortSignal; headers?: Record<string, string> }): Promise<Response> {
  let addresses: string[] = [];
  const resolver = options.resolve ?? (async host => (await lookup(host, { all: true, verbatim: true })).map(item => item.address));
  const url = await checkUrl(raw, { allowNetwork: options.allowNetwork, resolve: async host => { addresses = await resolver(host); return addresses; } });
  options.signal.throwIfAborted();
  if (options.networkAllowed?.() === false) throw new Error('Network access is disabled');
  const address = addresses[0] ?? url.hostname.replace(/^\[|\]$/gu, '');
  const family = address.includes(':') ? 6 : 4;
  return new Promise((ok, no) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      agent: false, family, signal: options.signal, headers: options.headers,
      lookup: (_host, lookupOptions, callback) => lookupOptions.all ? callback(null, [{ address, family }]) : callback(null, address, family),
    }, response => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (Array.isArray(value)) for (const part of value) headers.append(key, part); else if (value !== undefined) headers.set(key, value);
      const status = response.statusCode ?? 502;
      if ([204, 205, 304].includes(status)) { response.resume(); ok(new Response(null, { status, headers })); }
      else {
        const encoding = headers.get('content-encoding')?.toLowerCase();
        const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
        let body: Readable = response;
        if (decoder) { response.on('error', error => decoder.destroy(error)); decoder.on('error', () => response.destroy()); body = response.pipe(decoder); headers.delete('content-encoding'); headers.delete('content-length'); }
        else if (encoding && encoding !== 'identity') { response.destroy(); no(new Error('Unsupported HTTP content encoding')); return; }
        ok(new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status, headers }));
      }
    });
    request.on('error', no); request.end();
  });
}
