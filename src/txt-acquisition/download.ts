/**
 * Streaming download of raw bytes. The transfer never decodes text: GBK,
 * GB18030 and UTF-16 files arrive byte-for-byte and are decoded later, once,
 * by the import path. Every redirect hop is re-checked by `checkUrl`.
 */
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { fetchPinned } from './pinned-http.ts';
import { redactMessage } from './privacy.ts';
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
  networkAllowed?: () => boolean;
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

function abortable(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cancel:()=>void; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Download timed out')), timeoutMs);
  const onAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', onAbort, { once: true });
  if (parent?.aborted) onAbort();
  return {
    signal: controller.signal,
    cancel:()=>controller.abort(new Error('Network permission revoked')),
    done: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

export async function downloadFile(request: DownloadRequest): Promise<DownloadResult> {
  const doFetch = request.fetchImpl ?? ((url, init) => fetchPinned(String(url), { allowNetwork: request.allowNetwork, resolve: request.resolve, networkAllowed: request.networkAllowed, signal: limit.signal, headers: init?.headers as Record<string, string> })) as typeof fetch;
  const maxBytes = request.maxBytes ?? MAX_BOOK_BYTES;
  const timeoutMs = request.timeoutMs ?? 5 * 60_000;
  const limit = abortable(request.signal, timeoutMs);
  const attempt = await request.staging.beginDownload(request.taskId).catch(error => { limit.done(); throw error; });
  const { path: partPath, stream } = attempt;
  let rejectStorage!: (error: Error) => void;
  const storageFailure = new Promise<never>((_, reject) => { rejectStorage = reject; });
  void storageFailure.catch(() => undefined);
  stream.on('error', rejectStorage);
  const interrupted=()=>rejectStorage(new DownloadError(request.networkAllowed?.()===false?'policy_blocked':request.signal?.aborted?'cancelled':'timeout','Download was interrupted',request.networkAllowed?.()!==false));
  limit.signal.addEventListener('abort',interrupted,{once:true});if(limit.signal.aborted)interrupted();
  const permissionTimer=request.networkAllowed?setInterval(()=>{if(request.networkAllowed?.()===false)limit.cancel();},100):undefined;permissionTimer?.unref?.();

  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let hash = createHash('sha256');
  let bytes = 0;
  let contentLength: number | undefined;
  const cleanup = async () => {
    if (reader) await reader.cancel().catch(() => undefined); else await response?.body?.cancel().catch(() => undefined);
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
    let current = await Promise.race([checkUrl(request.url, { allowNetwork: request.allowNetwork, ...(request.resolve ? { resolve: request.resolve } : {}) }),storageFailure]);
    let redirects = 0;
    for (;;) {
      if(request.networkAllowed?.()===false)throw new DownloadError('policy_blocked','Network access is disabled',false);
      let hop: Response;
      try {
        hop = await Promise.race([doFetch(current.toString(), {
          redirect: 'manual',
          signal: limit.signal,
          headers: { 'user-agent': USER_AGENT, accept: 'text/plain,text/markdown,application/octet-stream,*/*;q=0.8', 'accept-encoding': 'identity' },
        }),storageFailure]);
      } catch (error) {
        if(error instanceof DownloadError)throw error;
        if (request.networkAllowed?.() === false) throw new DownloadError('policy_blocked', 'Network access is disabled', false);
        if (limit.signal.aborted) throw new DownloadError(request.signal?.aborted ? 'cancelled' : 'timeout', 'Download was interrupted', true);
        throw new DownloadError('network', `Download failed: ${redactMessage((error as Error).message)}`, true);
      }
      if (REDIRECT_STATUS.has(hop.status)) {
        const location = hop.headers.get('location');
        await hop.body?.cancel();
        if (!location) throw new DownloadError('http_error', `Redirect ${hop.status} without a Location header`, true);
        redirects += 1;
        if (redirects > MAX_REDIRECTS) throw new DownloadError('http_error', `More than ${MAX_REDIRECTS} redirects`, false);
        const next = new URL(location, current);
        try {
          current = await Promise.race([checkUrl(next.toString(), { allowNetwork: request.allowNetwork, ...(request.resolve ? { resolve: request.resolve } : {}) }),storageFailure]);
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
    reader = body.getReader();
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), storageFailure]);
      if (done) break;
      if (limit.signal.aborted) throw new DownloadError(request.signal?.aborted ? 'cancelled' : 'timeout', 'Download was interrupted', true);
      if (request.networkAllowed?.() === false) throw new DownloadError('policy_blocked', 'Network access is disabled', false);
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DownloadError('too_large', `Download exceeded the ${maxBytes} byte limit`, false);
      }
      hash.update(value);
      if (!stream.write(Buffer.from(value))) await Promise.race([new Promise<void>((resolve) => stream.once('drain', resolve)), storageFailure]);
      request.onProgress?.(bytes, contentLength);
    }
    await new Promise<void>((resolve, reject) => {
      stream.end(() => resolve());
      stream.on('error', reject);
    });
    if(request.networkAllowed?.()===false)throw new DownloadError('policy_blocked','Network access is disabled',false);
    limit.signal.throwIfAborted();

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
    if (limit.signal.aborted) throw new DownloadError(request.signal?.aborted ? 'cancelled' : 'timeout', 'Download was interrupted', true);
    if (isPolicyError(error)) throw new DownloadError('policy_blocked', error.message, false);
    const storageCode = (error as NodeJS.ErrnoException).code;
    if (storageCode && ['ENOSPC', 'EIO', 'EACCES', 'EPERM', 'EBUSY', 'EROFS'].includes(storageCode)) throw new DownloadError('storage_unavailable', 'Cannot write downloaded bytes (' + storageCode + ')', true);
    throw new DownloadError('download_failed', redactMessage((error as Error).message), true);
  } finally {
    if(permissionTimer)clearInterval(permissionTimer);limit.signal.removeEventListener('abort',interrupted);
    limit.done();
  }
}

