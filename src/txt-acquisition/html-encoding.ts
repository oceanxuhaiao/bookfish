/** Decode a bounded raw HTML response, never the TXT payload. BOM > HTTP > meta > UTF-8/GB18030. */
export function decodeHtml(bytes: Uint8Array, contentType = ''): { html: string; encoding: string } {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8' : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : undefined;
  const charset = /charset\s*=\s*["']?([^\s;"'>]+)/iu;
  const head = Buffer.from(bytes.subarray(0, 8192)).toString('latin1');
  const meta = head.match(/<meta\b[^>]*>/giu)?.map(tag => charset.exec(tag)?.[1]).find(Boolean);
  let encoding = bom ?? charset.exec(contentType)?.[1] ?? meta;
  if (encoding && /^(gbk|gb2312|gb18030|x-gbk)$/iu.test(encoding)) encoding = 'gb18030';
  if (!encoding) { try { return { html: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }; } catch { encoding = 'gb18030'; } }
  try { return { html: new TextDecoder(encoding).decode(bytes), encoding }; }
  catch { throw new Error('Unsupported HTML charset'); }
}
