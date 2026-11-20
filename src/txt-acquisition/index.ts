/** Public surface of the browser-assisted TXT acquisition module. */
export { TxtAcquisition, type AcquisitionOptions, type PageLoader, type PageLoadResult, type ImportOutcome } from './acquisition.ts';
export { AcquisitionStaging } from './staging.ts';
export { AcquisitionRecords } from './records.ts';
export { assessText, MIN_READABLE_CHARS, type Assessment, type IdentityMatch } from './quality.ts';
export { detectEncoding, decodeBestEffort, normalizeText, looksBinary, type DecodeResult, type NormalizeResult } from './repair.ts';
export { discoverLinks, extractIdentity, type DiscoveryResult } from './link-discovery.ts';
export { downloadFile, DownloadError, type DownloadRequest, type DownloadResult } from './download.ts';
export { BrowserClient, PageSession, BrowserError } from './browser-client.ts';
export { checkUrl, isBlockedAddress, isLoopbackWs, hostOf, UrlPolicyError, isPolicyError } from './url-policy.ts';
export * from './types.ts';
