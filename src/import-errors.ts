/**
 * Reader-facing wording for import failures.
 *
 * Import runs in a worker, so failures reach the panel as plain strings. This
 * module is the single place that turns the ones worth explaining into words a
 * reader can act on; everything else is passed through unchanged.
 */
export function describeImportError(error: string, say: (zh: string, english: string) => string): string {
  const scanned = /^No text layer: only (\d+) of (\d+) pages/u.exec(error);
  if (scanned) {
    return say(
      `这个 PDF 是扫描图：${scanned[2]} 页里只有 ${scanned[1]} 页有文字，没有能读的正文层，所以没有导入。先用 OCR 转成文字版，或者改导入 TXT/EPUB。`,
      `This PDF is a scan: only ${scanned[1]} of ${scanned[2]} pages have selectable text, so there is no readable body text and nothing was imported. OCR it first, or import a TXT/EPUB instead.`,
    );
  }
  return error;
}
