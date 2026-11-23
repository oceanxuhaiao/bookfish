/**
 * Real-tab page channel.
 *
 * The extension bridge fetches from a service worker, which some sites answer
 * with 403 or a redirect the bridge refuses. This channel instead drives one
 * explicitly configured loopback debug port and opens a real tab, so redirects,
 * cookies and page scripts behave the way they do for a person browsing.
 *
 * Deliberate limits stay: only the configured port, only targets this channel
 * created, the landed URL is re-checked, text-only downloads, byte caps and the
 * same hashing as every other route.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, rmSync, writeSync } from 'node:fs';
import { MAX_BOOK_BYTES } from '../books.ts';
import { BrowserClient, BrowserError, type PageSession } from './browser-client.ts';
import { DownloadError, TEXT_CONTENT_TYPE } from './download.ts';
import type { AcquisitionStaging } from './staging.ts';
import { checkUrl, type HostResolver } from './url-policy.ts';

const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 120_000;

export interface PageChannelOptions {
  port: number;
  fetchImpl?: typeof fetch;
  resolve?: HostResolver;
  /** Test seam: replace the CDP client without a browser. */
  client?: (port: number, fetchImpl?: typeof fetch) => BrowserClient;
}

export interface PageChannelSettings {
  allowNetwork: boolean;
  signal?: AbortSignal;
}

export interface LoadedPage {
  html: string;
  finalUrl: string;
  close: () => Promise<void>;
}

export interface ChannelDownload {
  partPath: string;
  bytes: number;
  sha256: string;
  contentType?: string;
  finalUrl: string;
}

interface OpenedPage { page: PageSession; client: BrowserClient; finalUrl: string }

export class PageChannel {
  constructor(private readonly options: PageChannelOptions) {}

  private connect(): BrowserClient {
    return this.options.client?.(this.options.port, this.options.fetchImpl)
      ?? new BrowserClient(this.options.port, this.options.fetchImpl);
  }

  private async check(raw: string, settings: PageChannelSettings): Promise<string> {
    const checked = await checkUrl(raw, {
      allowNetwork: settings.allowNetwork,
      ...(this.options.resolve ? { resolve: this.options.resolve } : {}),
    });
    return checked.href;
  }

  /** Open the address in a fresh background tab and return where it landed. */
  private async open(url: string, settings: PageChannelSettings): Promise<OpenedPage> {
    settings.signal?.throwIfAborted();
    const target = await this.check(url, settings);
    const client = this.connect();
    let page: PageSession | undefined;
    try {
      page = await client.createPage();
      settings.signal?.throwIfAborted();
      await page.navigate(target, 30_000);
      const finalUrl = await page.evaluate<string>('location.href');
      if (typeof finalUrl !== 'string' || !finalUrl.trim()) throw new BrowserError('policy_blocked', 'The browser did not report where the page landed');
      await this.check(finalUrl, settings);
      return { page, client, finalUrl };
    } catch (error) {
      await page?.close().catch(() => undefined);
      await client.disconnect().catch(() => undefined);
      throw error;
    }
  }

  async loadPage(url: string, settings: PageChannelSettings): Promise<LoadedPage> {
    const { page, client, finalUrl } = await this.open(url, settings);
    try {
      settings.signal?.throwIfAborted();
      const html = await page.evaluate<string>('document.documentElement.outerHTML');
      if (typeof html !== 'string') throw new BrowserError('browser_unavailable', 'The page returned no HTML');
      if (Buffer.byteLength(html, 'utf8') > MAX_PAGE_BYTES) throw new BrowserError('too_large', 'The page is too large');
      return {
        html,
        finalUrl,
        close: async () => { await page.close().catch(() => undefined); await client.disconnect().catch(() => undefined); },
      };
    } catch (error) {
      await page.close().catch(() => undefined);
      await client.disconnect().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Read the file's original bytes from the page context. The tab is already on
   * the file's final address, so `fetch(location.href)` is same-origin and keeps
   * the browser's cookies; bytes are pulled in bounded base64 chunks.
   */
  async download(url: string, request: { staging: AcquisitionStaging; taskId: string; filename: string } & PageChannelSettings): Promise<ChannelDownload> {
    const { page, client, finalUrl } = await this.open(url, request);
    const partPath = request.staging.partialPath(`${request.taskId}-${randomUUID()}`);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      request.signal?.throwIfAborted();
      const info = await this.evaluate<{ bytes?: number; type?: string; status?: number; error?: string }>(page, `(async () => {
        try {
          const response = await fetch(location.href, { credentials: 'include', cache: 'no-store' });
          if (!response.ok) return { status: response.status, error: 'HTTP ' + response.status };
          const type = response.headers.get('content-type') || '';
          const buffer = new Uint8Array(await response.arrayBuffer());
          window.__bookfish_page = { bytes: buffer, offset: 0 };
          return { bytes: buffer.length, type };
        } catch (error) { return { error: String((error && error.message) || error) }; }
      })()`);
      if (info.error) {
        const code = info.status === 401 || info.status === 403 ? 'permission_missing' : info.status ? 'http_error' : 'network';
        throw new BrowserError(code, `The browser could not read the file (${info.error})`);
      }
      const total = Number(info.bytes ?? 0);
      if (!Number.isFinite(total) || total < 0) throw new BrowserError('download_failed', 'The browser returned no byte count');
      if (total > MAX_BOOK_BYTES) throw new BrowserError('too_large', 'The file is too large');
      if (info.type && !TEXT_CONTENT_TYPE.test(info.type)) {
        throw new DownloadError('download_failed', /html/iu.test(info.type) ? 'The address returned an HTML page, not a text file' : 'The server returned an unsupported content type', false);
      }
      const fd = openSync(partPath, 'wx', 0o600);
      try {
        for (let offset = 0; offset < total; offset += CHUNK_BYTES) {
          request.signal?.throwIfAborted();
          const encoded = await this.evaluate<string>(page, `(() => {
            const state = window.__bookfish_page;
            const end = Math.min(state.bytes.length, state.offset + ${CHUNK_BYTES});
            let text = '';
            for (let index = state.offset; index < end; index += 1) text += String.fromCharCode(state.bytes[index]);
            state.offset = end;
            return btoa(text);
          })()`);
          const chunk = Buffer.from(String(encoded ?? ''), 'base64');
          if (!chunk.length) throw new BrowserError('download_failed', 'The browser returned no more bytes');
          writeSync(fd, chunk);
          hash.update(chunk);
          bytes += chunk.length;
          if (bytes > MAX_BOOK_BYTES) throw new BrowserError('too_large', 'The file is too large');
        }
      } finally { closeSync(fd); }
      if (bytes !== total) throw new BrowserError('download_failed', 'The browser byte count does not match');
      const digest = hash.digest('hex');
      return { partPath, bytes, sha256: digest, ...(info.type ? { contentType: info.type } : {}), finalUrl };
    } catch (error) {
      rmSync(partPath, { force: true });
      throw error;
    } finally {
      await page.evaluate('(() => { delete window.__bookfish_page; return true; })()').catch(() => undefined);
      await page.close().catch(() => undefined);
      await client.disconnect().catch(() => undefined);
    }
  }

  private async evaluate<T>(page: PageSession, expression: string): Promise<T> {
    const result = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, FETCH_TIMEOUT_MS) as {
      result?: { value?: T };
      exceptionDetails?: { text?: string };
    };
    if (result.exceptionDetails) throw new BrowserError('browser_unavailable', result.exceptionDetails.text ?? 'Page script failed');
    return result.result?.value as T;
  }
}
