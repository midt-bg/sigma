const FORMULA_PREFIX = /^(?:[\s\uFEFF\u0000-\u001F]*[=+\-@＝＋－﹣−＠]|[\t\r\n])/u;
const QUOTE_TRIGGER = /[",\n\r]/;

export function csvCell(v: unknown): string {
  if (v == null) return '';
  let s = String(v);
  const neutralized = FORMULA_PREFIX.test(s);
  if (neutralized) s = "'" + s;
  return neutralized || QUOTE_TRIGGER.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A streamed text/csv Response (never buffered): BOM + header line, then each `fetchPage` batch
 * mapped through `toCells` → csvCell, until a batch shorter than `chunk` ends the walk. */
export function csvResponse<R>(
  header: readonly string[],
  chunk: number,
  fetchPage: () => Promise<R[]>,
  toCells: (row: R) => unknown[],
  filename: string,
): Response {
  let done = false;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('\uFEFF' + header.join(',') + '\n'));
    },
    async pull(controller) {
      if (done) return;
      const results = await fetchPage();
      if (!results.length) {
        done = true;
        controller.close();
        return;
      }
      let block = '';
      for (const r of results) block += toCells(r).map(csvCell).join(',') + '\n';
      controller.enqueue(enc.encode(block));
      if (results.length < chunk) {
        done = true;
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
