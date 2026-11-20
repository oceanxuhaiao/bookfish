/**
 * URL policy for the acquisition engine. Every hop — the page the model names,
 * each redirect, and the resolved download address — must pass `checkUrl`.
 *
 * Only public HTTP(S) is allowed: loopback, private, carrier-grade NAT, link
 * local, multicast, reserved and cloud metadata addresses are refused, both as
 * literals and as DNS answers. CDP is never pointed at a caller-supplied URL
 * without this check.
 */
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export class UrlPolicyError extends Error {
  readonly code = 'policy_blocked';
  constructor(message: string) {
    super(message);
    this.name = 'UrlPolicyError';
  }
}

export type HostResolver = (host: string) => Promise<string[]>;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.home.arpa', '.lan', '.corp'];

/** Cloud metadata endpoints that live inside otherwise routable ranges. */
const BLOCKED_EXACT = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200', 'fd00:ec2::254']);

const defaultResolver: HostResolver = async (host) => {
  const records = await dnsLookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

export function isBlockedAddress(address: string): boolean {
  const normalized = address.replace(/%.*$/u, '').trim();
  if (BLOCKED_EXACT.has(normalized)) return true;
  if (!ipaddr.isValid(normalized)) return true;
  const parsed = ipaddr.parse(normalized);
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return isBlockedAddress(v6.toIPv4Address().toString());
    return v6.range() !== 'unicast';
  }
  return (parsed as ipaddr.IPv4).range() !== 'unicast';
}

function blockedHostname(host: string): boolean {
  const name = host.toLowerCase().replace(/\.+$/u, '');
  if (!name) return true;
  if (BLOCKED_HOSTNAMES.has(name)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  return name.split('.').length === 1 && !name.includes(':');
}

export interface UrlPolicyOptions {
  /** When false every network reachability check is refused (worlds.bookfish.allowNetwork). */
  allowNetwork: boolean;
  resolve?: HostResolver;
}

/**
 * Validate and normalize a URL for outbound use. Returns the parsed URL with
 * credentials stripped. Throws UrlPolicyError with a short, non-leaking reason.
 */
export async function checkUrl(raw: string, options: UrlPolicyOptions): Promise<URL> {
  if (!options.allowNetwork) throw new UrlPolicyError('Network access is disabled for this world');
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new UrlPolicyError('Not a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlPolicyError(`Only http and https are allowed, not ${url.protocol.replace(':', '')}`);
  }
  url.username = '';
  url.password = '';
  // WHATWG keeps IPv6 brackets in `hostname`; strip them for literal checks.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (!host) throw new UrlPolicyError('URL has no host');
  if (blockedHostname(host)) throw new UrlPolicyError(`Refusing local or internal host ${host}`);
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new UrlPolicyError(`Refusing non-public address ${host}`);
    return url;
  }
  const resolve = options.resolve ?? defaultResolver;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new UrlPolicyError(`Cannot resolve ${host}`);
  }
  if (!addresses.length) throw new UrlPolicyError(`Cannot resolve ${host}`);
  for (const address of addresses) {
    if (isBlockedAddress(address)) throw new UrlPolicyError(`Refusing ${host}: resolves to non-public address`);
  }
  return url;
}

/** Human-facing host label without path or query. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Short reason hooks so callers can classify failures without leaking URLs. */
export function isPolicyError(error: unknown): error is UrlPolicyError {
  return error instanceof UrlPolicyError || (error as { code?: string } | null)?.code === 'policy_blocked';
}

/**
 * A CDP WebSocket must be plain `ws:` on the configured loopback port. A remote
 * or mismatched address is refused, so a hostile `/json/version` payload cannot
 * redirect the agent's privileged session elsewhere.
 */
export function isLoopbackWs(raw: string, port: number): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'ws:') return false;
  if (url.username || url.password) return false;
  if (url.port !== String(port)) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
