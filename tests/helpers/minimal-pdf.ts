/**
 * Build a tiny but valid PDF in memory so PDF import tests can describe page
 * layouts (one text page among many blank scans) without binary fixtures.
 * ASCII only: the standard Helvetica font with WinAnsi encoding is enough for
 * tests that care about page coverage, not typography.
 */
export function buildPdf(pages: string[]): Uint8Array {
  const escape = (value: string) => value.replace(/\\/gu, '\\\\').replace(/\(/gu, '\\(').replace(/\)/gu, '\\)');
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pages.forEach((text, index) => {
    const pageId = 4 + index * 2;
    const contentId = 5 + index * 2;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    const stream = text
      ? `BT /F1 12 Tf 72 760 Td 16 TL\n${text.split('\n').map((line) => `(${escape(line)}) Tj T*`).join('\n')}\nET`
      : '';
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  const chunks: string[] = ['%PDF-1.4\n'];
  const offsets: number[] = [];
  let offset = chunks[0]!.length;
  for (let id = 1; id < objects.length; id += 1) {
    const chunk = `${id} 0 obj\n${objects[id]}\nendobj\n`;
    offsets[id] = offset;
    offset += chunk.length;
    chunks.push(chunk);
  }
  const startxref = offset;
  const xref = [`xref\n0 ${objects.length}\n`, '0000000000 65535 f \n'];
  for (let id = 1; id < objects.length; id += 1) xref.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  chunks.push(xref.join(''), `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`);
  return new Uint8Array(Buffer.from(chunks.join(''), 'latin1'));
}
