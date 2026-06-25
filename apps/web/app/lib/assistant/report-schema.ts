// Report block vocabulary + server-side value binding.
//
// Integrity rule (spec §4 + §9 point 1): the model NEVER writes data values. It emits blocks that
// *reference* handles into result sets the server actually executed (run_sql / curated tools); the
// server re-binds the real values. A 27B model that fabricates a row or writes 12 млрд. instead of
// 1,2 млрд. therefore cannot reach a published, citable report — the defamation/disinfo vector in
// architecture.md §3. Only `text`/`callout` carry model prose; it is markdown-sanitized (no raw
// HTML — closes the stored-XSS vector on the public /reports/:id, spec §7) and must not carry
// material numbers.
//
// This module is pure (no deps, no bindings) so it is unit-testable and deploy-independent.

export type CellFormat = 'money' | 'number' | 'percent' | 'date' | 'text';
export type EntityKind = 'company' | 'authority' | 'contract';

/**
 * A result set the server obtained from a server-executed tool. `handle` is what the model uses to
 * reference it (e.g. "R1"). Values are primitives only — never markup. Rows are aligned to columns.
 */
export interface QueryResult {
  handle: string;
  columns: string[];
  rows: (string | number | null)[][];
  truncated?: boolean; // run_sql byte/row cap hit (spec §7) — surfaced in the callout
}

// A pointer to a single cell in a result set. The only way the model can place a number anywhere.
export interface CellRef {
  resultId: string;
  row: number;
  col: string;
}

// ── What the MODEL emits via emit_report (no literal data values in data blocks) ──────────────────
export interface EmitText {
  type: 'text';
  md: string;
}
export interface EmitCallout {
  type: 'callout';
  title: string;
  md: string;
}
export interface EmitTotals {
  type: 'totals';
  items: { label: string; ref: CellRef; format: CellFormat }[];
}
export interface EmitFacts {
  type: 'facts';
  items: { term: string; ref: CellRef; sub?: string }[];
}
export interface EmitTableColumn {
  key: string; // must name a column of the referenced result
  header: string;
  align?: 'left' | 'right';
  format: CellFormat;
  link?: { kind: EntityKind; idCol: string }; // renderer builds the canonical /companies/:eik etc.
}
export interface EmitTable {
  type: 'table';
  resultId: string; // rows come wholesale from this result — the model cannot inject fabricated rows
  columns: EmitTableColumn[];
}
export interface EmitBar {
  type: 'bar';
  resultId: string;
  labelCol: string;
  valueCol: string;
}
export interface EmitFlows {
  type: 'flows';
  resultId: string;
  fromCol: string;
  toCol: string;
  valueCol: string;
}
export interface EmitTimeseries {
  type: 'timeseries';
  resultId: string;
  periodCol: string;
  valueCol: string;
}
export type EmitBlock =
  | EmitText
  | EmitCallout
  | EmitTotals
  | EmitFacts
  | EmitTable
  | EmitBar
  | EmitFlows
  | EmitTimeseries;

export interface EmitReportInput {
  title: string;
  question: string; // the asked question — shown on the report (watermark, spec §9 point 12)
  blocks: EmitBlock[];
}

// ── What the RENDERER consumes (resolved, server-owned values) ────────────────────────────────────
export interface ResolvedRow {
  cells: (string | number | null)[];
  // Raw entity id per column for columns that declare a `link` (else null), aligned to `columns`.
  // The renderer builds the canonical href via entityHref(kind, id); kept separate so the id need not
  // be a visible column (§4 "links by entity-ref, not URL"). Without this an immutable R2 report could
  // not reconstruct its links.
  links?: (string | null)[];
}
export type ResolvedBlock =
  | { type: 'text'; md: string }
  | { type: 'callout'; title: string; md: string }
  | {
      type: 'totals';
      items: { label: string; value: string | number | null; format: CellFormat }[];
    }
  | { type: 'facts'; items: { term: string; value: string | number | null; sub?: string }[] }
  | {
      type: 'table';
      columns: EmitTableColumn[];
      rows: ResolvedRow[];
    }
  | { type: 'bar'; points: { label: string | number | null; value: number }[] }
  | { type: 'flows'; edges: { from: string; to: string; valueEur: number }[] }
  | { type: 'timeseries'; points: { period: string | number | null; value: number }[] };

export interface ResolvedReport {
  title: string;
  question: string;
  blocks: ResolvedBlock[];
  watermark: 'ai-generated'; // renderer always shows the „AI-генерирано, неофициално" label (§9.12)
}

export type BindResult = { ok: true; report: ResolvedReport } | { ok: false; errors: string[] };

// Strip raw HTML so model prose can never inject markup into the public report (spec §7/§9). Loops the
// strip to a FIXPOINT: a single `<[^>]*>` pass can REASSEMBLE a live tag from nested/overlapping input
// (`<scr<script>ipt>` collapses to `<script>`), so it must repeat until the string stops changing
// (review #80, ydimitrof H2). Each pass also drops a trailing UNTERMINATED tag-open (`<img src=x
// onerror=…` with no closing `>`). Until the Phase-2 markdown renderer (no raw-HTML passthrough) lands
// as the second layer, this strip is the SOLE barrier, so it must hold on its own.
export function sanitizeProse(md: string): string {
  let prev: string;
  let out = md;
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, '').replace(/<\/?[a-zA-Z][^>]*$/g, '');
  } while (out !== prev);
  // Defang dangerous URL schemes a markdown link/image target could carry — `[t](javascript:…)` is NOT
  // inside <…>, so the tag strip misses it, and a markdown renderer would emit an executable href
  // (review #80). javascript:/vbscript: are never legitimate prose (and could autolink), so defang them
  // anywhere; data:/file: are common words, so defang them ONLY inside a markdown link/image target
  // `](…)` to avoid mangling normal prose. The Phase-2 renderer MUST additionally allowlist URL schemes
  // (urlTransform → http/https/mailto only); this is the defence-in-depth until it lands.
  out = out
    .replace(/\b(?:javascript|vbscript)\s*:/gi, 'unsafe:')
    .replace(/(\]\(\s*)(?:data|file)\s*:/gi, '$1unsafe:');
  return out.trim();
}

// Data cells carry submitter-influenceable text (company/authority names, contract subjects). Tag-strip
// string values so no markup survives into the public report even if a renderer forgets to escape —
// defence-in-depth on top of React's default escaping (spec §7). Numbers/null are never markup.
export function sanitizeCell(v: string | number | null): string | number | null {
  return typeof v === 'string' ? sanitizeProse(v) : v;
}

// Guardrail E2 (spec addendum): a DETERMINISTIC check that model prose carries no material number —
// not a prompt rule. The model must place numbers in value slots (totals/table/…) which the server
// binds; a number inside `text`/`callout` is unbound and unverifiable — the "12 млрд." defamation
// vector. Flags currency amounts, magnitude words (млн/млрд/хил.), grouped numbers (1 234 / 1,234,567 /
// 1.234.567) and integers ≥ 5 digits. Bare ≤4-digit numbers (years, small counts, ordinals) pass, to
// keep false positives low.
const PROSE_NUMBER_PATTERNS: RegExp[] = [
  /(?:€|eur)\s*\d[\d.,\s]*/giu, // €1234, EUR 1 234
  /\d[\d.,\s]*\s*(?:€|лв\.?|eur|евро|лева)/giu, // 1 234 лв, 1234 евро
  /\d[\d.,\s]*\s*(?:млн|млрд|хил)\.?/giu, // 12 млрд, 1,2 млн
  /\d{1,3}(?:[.,\s'’]\d{3})+/gu, // grouped: 1 234, 1,234,567, 1.234.567, 12'000'000 (apostrophe)
  /\d(?:[.,]\d+)?[eE][+-]?\d+/gu, // scientific notation: 1.2e10, 12E9
  /\d{5,}/gu, // 10000+ (years are ≤4 digits)
];

const codePoint = (n: number, fallback: string): string =>
  Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;

// Normalise prose to what a reader/renderer actually sees, so the number gate is not blinded by markup.
// Markdown can split a number from its magnitude word (`**12** **млрд.**` → "12 млрд."); a renderer
// collapses zero-width separators (`1​234​567` → "1234567") and decodes numeric HTML entities
// (`12&#48;&#48;&#48;` → "12000"). Decode/strip those, drop emphasis, collapse whitespace (review #80).
function deMarkdown(text: string): string {
  return text
    .replace(/&#(\d{1,7});/g, (m, d) => codePoint(Number(d), m))
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (m, h) => codePoint(parseInt(h, 16), m))
    .replace(/[\u200b-\u200d\ufeff]/g, '') // zero-width space / non-joiner / joiner / BOM
    .replace(/[*_`~\\]/g, '')
    .replace(/\s+/g, ' ');
}

/** Return the material-number tokens found in prose (empty ⇒ clean). Used to gate text/callout. */
export function findProseNumbers(text: string): string[] {
  const hits: string[] = [];
  // Scan the raw text AND a markdown-stripped copy so neither plain nor markup-split numbers slip.
  for (const scan of [text, deMarkdown(text)]) {
    for (const re of PROSE_NUMBER_PATTERNS) {
      for (const m of scan.matchAll(re)) hits.push(m[0].trim());
    }
  }
  return [...new Set(hits)].filter(Boolean);
}

function asNumber(v: string | number | null): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * Re-bind a model-emitted report against the server's own result sets. Every number on the page is
 * sourced here from `results`; the model's blocks only select/label/shape. Returns validation
 * errors instead of a report if any reference is dangling — the model then retries (spec §4).
 */
export function bindReport(input: EmitReportInput, results: QueryResult[]): BindResult {
  const errors: string[] = [];
  const byHandle = new Map(results.map((r) => [r.handle, r]));

  const cell = (ref: CellRef, where: string): string | number | null => {
    const r = byHandle.get(ref.resultId);
    if (!r) {
      errors.push(`${where}: unknown result handle "${ref.resultId}"`);
      return null;
    }
    const colIdx = r.columns.indexOf(ref.col);
    if (colIdx < 0) {
      errors.push(`${where}: result "${ref.resultId}" has no column "${ref.col}"`);
      return null;
    }
    if (ref.row < 0 || ref.row >= r.rows.length) {
      errors.push(
        `${where}: result "${ref.resultId}" row ${ref.row} out of range (0..${r.rows.length - 1})`,
      );
      return null;
    }
    // Guard the cell access: a ragged row (shorter than columns) would make a non-null assertion lie
    // and surface `undefined`. Real results from toQueryResult are rectangular, so this is defensive.
    const value = r.rows[ref.row]?.[colIdx];
    return value === undefined ? null : value;
  };

  const requireResult = (resultId: string, where: string): QueryResult | null => {
    const r = byHandle.get(resultId);
    if (!r) errors.push(`${where}: unknown result handle "${resultId}"`);
    return r ?? null;
  };

  const requireCols = (r: QueryResult, cols: string[], where: string): boolean => {
    let ok = true;
    for (const c of cols) {
      if (!r.columns.includes(c)) {
        errors.push(`${where}: result "${r.handle}" has no column "${c}"`);
        ok = false;
      }
    }
    return ok;
  };

  const colValues = (r: QueryResult, col: string) => {
    const i = r.columns.indexOf(col);
    return r.rows.map((row) => row[i] ?? null);
  };

  const blocks: ResolvedBlock[] = [];
  input.blocks.forEach((b, bi) => {
    const at = `block[${bi}] (${b.type})`;
    switch (b.type) {
      case 'text': {
        const nums = findProseNumbers(b.md);
        if (nums.length)
          errors.push(
            `${at}: material numbers belong in a value block, not text prose (${nums.join(', ')})`,
          );
        blocks.push({ type: 'text', md: sanitizeProse(b.md) });
        break;
      }
      case 'callout': {
        const nums = [...findProseNumbers(b.title), ...findProseNumbers(b.md)];
        if (nums.length)
          errors.push(
            `${at}: material numbers belong in a value block, not callout prose (${nums.join(', ')})`,
          );
        blocks.push({ type: 'callout', title: sanitizeProse(b.title), md: sanitizeProse(b.md) });
        break;
      }
      case 'totals':
        blocks.push({
          type: 'totals',
          items: b.items.map((it) => {
            const nums = findProseNumbers(it.label);
            if (nums.length)
              errors.push(
                `${at}: material number in totals label — put it in a value slot (${nums.join(', ')})`,
              );
            return {
              label: sanitizeProse(it.label),
              value: sanitizeCell(cell(it.ref, at)),
              format: it.format,
            };
          }),
        });
        break;
      case 'facts':
        blocks.push({
          type: 'facts',
          items: b.items.map((it) => {
            const numsT = findProseNumbers(it.term);
            if (numsT.length)
              errors.push(
                `${at}: material number in facts term — put it in a value slot (${numsT.join(', ')})`,
              );
            if (it.sub) {
              const numsS = findProseNumbers(it.sub);
              if (numsS.length)
                errors.push(
                  `${at}: material number in facts sub — put it in a value slot (${numsS.join(', ')})`,
                );
            }
            return {
              term: sanitizeProse(it.term),
              value: sanitizeCell(cell(it.ref, at)),
              sub: it.sub != null ? sanitizeProse(it.sub) : undefined,
            };
          }),
        });
        break;
      case 'table': {
        const r = requireResult(b.resultId, at);
        // Require both the display columns AND the link id columns to exist — without the latter an
        // immutable report could not reconstruct its entity links.
        const needed = [
          ...b.columns.map((c) => c.key),
          ...b.columns.flatMap((c) => (c.link ? [c.link.idCol] : [])),
        ];
        if (r && requireCols(r, needed, at)) {
          for (const col of b.columns) {
            const nums = findProseNumbers(col.header);
            if (nums.length)
              errors.push(
                `${at}: material number in column header "${col.key}" (${nums.join(', ')})`,
              );
          }
          const idx = b.columns.map((c) => r.columns.indexOf(c.key));
          const linkIdx = b.columns.map((c) => (c.link ? r.columns.indexOf(c.link.idCol) : -1));
          blocks.push({
            type: 'table',
            columns: b.columns.map((c) => ({ ...c, header: sanitizeProse(c.header) })),
            rows: r.rows.map((row) => ({
              cells: idx.map((i) => sanitizeCell(row[i] ?? null)),
              links: linkIdx.map((i) => {
                const v = i < 0 ? null : row[i];
                return v == null ? null : String(v);
              }),
            })),
          });
        }
        break;
      }
      case 'bar': {
        const r = requireResult(b.resultId, at);
        if (r && requireCols(r, [b.labelCol, b.valueCol], at)) {
          const labels = colValues(r, b.labelCol);
          const vals = colValues(r, b.valueCol);
          const points: { label: string | number | null; value: number }[] = [];
          for (let i = 0; i < labels.length; i++) {
            const value = asNumber(vals[i] ?? null);
            if (value !== null) points.push({ label: sanitizeCell(labels[i] ?? null), value });
          }
          blocks.push({ type: 'bar', points });
        }
        break;
      }
      case 'flows': {
        const r = requireResult(b.resultId, at);
        if (r && requireCols(r, [b.fromCol, b.toCol, b.valueCol], at)) {
          const from = colValues(r, b.fromCol);
          const to = colValues(r, b.toCol);
          const val = colValues(r, b.valueCol);
          const edges: { from: string; to: string; valueEur: number }[] = [];
          for (let i = 0; i < from.length; i++) {
            const valueEur = asNumber(val[i] ?? null);
            if (valueEur !== null)
              edges.push({
                from: sanitizeProse(String(from[i] ?? '')),
                to: sanitizeProse(String(to[i] ?? '')),
                valueEur,
              });
          }
          blocks.push({ type: 'flows', edges });
        }
        break;
      }
      case 'timeseries': {
        const r = requireResult(b.resultId, at);
        if (r && requireCols(r, [b.periodCol, b.valueCol], at)) {
          const period = colValues(r, b.periodCol);
          const vals = colValues(r, b.valueCol);
          const points: { period: string | number | null; value: number }[] = [];
          for (let i = 0; i < period.length; i++) {
            const value = asNumber(vals[i] ?? null);
            if (value !== null) points.push({ period: sanitizeCell(period[i] ?? null), value });
          }
          blocks.push({ type: 'timeseries', points });
        }
        break;
      }
    }
  });

  if (!input.title.trim()) errors.push('report title is empty');
  const titleNums = findProseNumbers(input.title);
  if (titleNums.length)
    errors.push(
      `report title: material number in title — put it in a value block (${titleNums.join(', ')})`,
    );
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    report: {
      title: sanitizeProse(input.title.trim()),
      question: sanitizeProse(input.question),
      blocks,
      watermark: 'ai-generated',
    },
  };
}
