/**
 * Streaming download of raw bytes. The transfer never decodes text: GBK,
 * GB18030 and UTF-16 files arrive byte-for-byte and are decoded later, once,
 * by the import path. Every redirect hop is re-checked by `checkUrl`.
 */
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { MAX_REDIRECTS } from './types.ts';
import { checkUrl, isPolicyError, type HostResolver } from './url-policy.ts';
import type { AcquisitionStaging } from './staging.ts';
import { MAX_BOOK_BYTES } from '../books.ts';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BookFish/0.63.0 txt-acquisition';
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
export const TEXT_CONTENT_TYPE = /^(text\/plain|text\/markdown|text\/x-markdown|application\/octet-stream|application\/x-download|binary\/octet-stream)(\s*;.*)?$/iu;

export class DownloadError extends Error {
  constructor(readonly code: string, message: string, readonly recoverable: boolean) {
    super(message);
    this.name = 'DownloadError';
  }
}

export interface DownloadRequest {
  url: string;
  allowNetwork: boolean;
  staging: AcquisitionStaging;
  taskId: string;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (received: number, total?: number) => void;
  fetchImpl?: typeof fetch;
  resolve?: HostResolver;
}

export interface DownloadResult {
  partPath: string;
  bytes: number;
  sha256: string;
  contentType?: string;
  finalUrl: string;
  redirects: number;
}

function abortable(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Download timed out')), timeoutMs);
  const onAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

export async function downloadFile(request: DownloadRequest): Promise<DownloadResult> {
  const doFetch = request.fetchImpl ?? fetch;
  const maxBytes = request.maxBytes ?? MAX_BOOK_BYTES;
  const timeoutMs = request.timeoutMs ?? 5 * 60_000;
  const limit = abortable(request.signal, timeoutMs);
  const { path: partPath, stream } = await request.staging.beginDownload(request.taskId);

  let hash = createHash('sha256');
  let bytes = 0;
  let contentLength: number | undefined;
  const cleanup = async () => {
    // Windows keeps the handle busy until the stream closes, so wait for it
    // before unlinking the partial file.
    if (!stream.closed) {
      const closed = once(stream, 'close').catch(() => undefined);
      stream.destroy();
      await closed;
    }
    await request.staging.removeIfPresent(partPath);
  };

  try {
    let current = await checkUrl(request.url, { allowNetwork: request.allowNetwork, ...(request.resolve ? { resolve: request.resolve } : {}) });
    let redirects = 0;
    let response: Response | undefined;
    for (;;) {
      let hop: Response;
      try {
        hop = await doFetch(current.toString(), {
          redirect: 'manual',
          signal: limit.signal,
          headers: { 'user-agent': USER_AGENT, accept: 'text/plain,text/markdown,application/octet-stream,*/*;q=0.8', 'accept-encoding': 'identity' },
        });
      } catch (error) {
        if (limit.signal.aborted) throw new DownloadError('cancelled', 'Download was cancelled', true);
        throw new DownloadError('network', `Download failed: ${(error as Error).message}`, true);
      }
      if (REDIRECT_STATUS.has(hop.status)) {
        const location = hop.headers.get('location');
        if (!location) throw new DownloadError('http_error', `Redirect ${hop.status} without a Location header`, true);
        redirects += 1;
        if (redirects > MAX_REDIRECTS) throw new DownloadError('http_error', `More than ${MAX_REDIRECTS} redirects`, false);
        const next = new URL(location, current);
        try {
          current = await checkUrl(next.toString(), { allowNetwork: request.allowNetwork, ...(request.resolve ? { resolve: request.resolve } : {}) });
        } catch (error) {
          throw new DownloadError('policy_blocked', isPolicyError(error) ? error.message : 'Redirect target refused by the URL policy', false);
        }
        continue;
      }
      if (!hop.ok) throw new DownloadError('http_error', `Server responded ${hop.status}`, hop.status >= 500 || hop.status === 429);
      response = hop;
      break;
    }

    const contentType = response.headers.get('content-type') ?? undefined;
    if (contentType && /text\/html|application\/xhtml/iu.test(contentType)) {
      throw new DownloadError('download_failed', 'The address returned an HTML page, not a text file', true);
    }
    if (contentType && !TEXT_CONTENT_TYPE.test(contentType)) {
      throw new DownloadError('download_failed', `Unexpected content type ${contentType.split(';')[0]?.trim() ?? contentType}`, true);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isSafeInteger(declared) && declared > 0) contentLength = declared;
    if (contentLength && contentLength > maxBytes) {
      throw new DownloadError('too_large', `File is ${contentLength} bytes, above the ${maxBytes} byte limit`, false);
    }

    const body = response.body;
    if (!body) throw new DownloadError('download_failed', 'The server sent no body', true);
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (limit.signal.aborted) throw new DownloadError('cancelled', 'Download was cancelled', true);
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DownloadError('too_large', `Download exceeded the ${maxBytes} byte limit`, false);
      }
      hash.update(value);
      if (!stream.write(Buffer.from(value))) await new Promise<void>((resolve) => stream.once('drain', resolve));
      request.onProgress?.(bytes, contentLength);
    }
    await new Promise<void>((resolve, reject) => {
      stream.end(() => resolve());
      stream.on('error', reject);
    });

    return {
      partPath,
      bytes,
      sha256: hash.digest('hex'),
      ...(contentType ? { contentType: contentType.split(';')[0]!.trim() } : {}),
      finalUrl: current.toString(),
      redirects,
    };
  } catch (error) {
    stream.destroy();
    await cleanup();
    if (error instanceof DownloadError) throw error;
    if (limit.signal.aborted) throw new DownloadError('cancelled', 'Download was cancelled', true);
    if (isPolicyError(error)) throw new DownloadError('policy_blocked', error.message, false);
    throw new DownloadError('download_failed', (error as Error).message, true);
  } finally {
    limit.done();
  }
}

