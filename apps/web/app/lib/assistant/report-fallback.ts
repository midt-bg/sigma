// Server-side last-resort report finalizer.
//
// The weak chat model sometimes gathers real data (one or more run_sql results) but never produces a
// VALID emit_report within the step budget — it puts a number in prose (correctly gated), gets the block
// shape wrong, or simply runs out of steps. The turn then dead-ends on the insufficient-data failure
// line (INSUFFICIENT_DATA_MESSAGE) even though the answer is sitting in `ctx.results`. This module synthesizes a minimal,
// SERVER-OWNED report from those results so the turn always finalizes with the real figures.
//
// Integrity is preserved end-to-end: the blocks are authored here but bound through the SAME `bindReport`
// path as a model-emitted report — every value still references a server-executed result handle, never a
// model-written literal (spec §9.1). Only the block scaffolding (which column → which block) is chosen by
// this code, from the result's own shape.

import {
  bindReport,
  isImplausibleRatio,
  type BindResult,
  type CellFormat,
  type EmitBlock,
  type QueryResult,
} from './report-schema';

// A fixed, number-free title so the fallback can NEVER trip the material-number title gate (E2) — a
// fallback that could fail its own validation would defeat the purpose. The question is shown verbatim
// beneath it (server-authoritative), so the report still reads in context.
export const FALLBACK_TITLE = 'Справка по наличните данни';

// Turn a raw SQL column name into a human Bulgarian label, so a server-synthesized fallback doesn't show
// `total_spent_eur` / `contracts_count` to the reader. A curated map covers the columns the model actually
// produces (per describe-schema's canonical queries); anything unrecognised degrades to a de-snaked,
// capitalised form (never the raw identifier). Only the DISPLAY label changes — the bound value still
// references the real column.
const COLUMN_LABELS: [RegExp, string][] = [
  [/^period$|^месец$|^month$|тримесеч|quarter/, 'Период'],
  [/^year$|^година$|годин/, 'Година'],
  [/(spent|похарчен|разход)/, 'Общо похарчено (€)'],
  [/(won|спечелен)/, 'Спечелено (€)'],
  // The „(€)" value label needs a real currency token (amount/value/стойност/сума), or a bare `total`/`sum`
  // that is NOT count-shaped — otherwise a tally like total_count/total_bids/sum_offers would render under
  // „Обща стойност (€)" (e.g. total_count = 293 → „Обща стойност (€): 293"). Mirrors guessFormat's guard.
  [
    /(amount|value|стойност|сума)|(?:sum|total)(?!.*(?:count|contracts|number|броя|договор|бр_|оферт|bids|offers))/,
    'Обща стойност (€)',
  ],
  [/(single.?offer|една.?оферта).*(share|дял)|(share|дял).*(single|оферта)/, 'Дял с една оферта'],
  [/(share|дял|percent|процент)/, 'Дял'],
  [
    /(contract|договор).*(count|брой|number|num|_n\b)|(count|брой).*(contract|договор)|^contracts?$|^договори$/,
    'Брой договори',
  ],
  [/оферт|bids|offers/, 'Брой оферти'],
  [/count|брой|number$|^n$|^n_/, 'Брой'],
  [/authorit|възложител/, 'Възложител'],
  [/bidder|contractor|company|изпълнител|компани|фирма/, 'Изпълнител'],
  [/sector|cpv|сектор/, 'Сектор'],
  [/signed|date|дата/, 'Дата'],
  [/name|title|наименование|^име$/, 'Наименование'],
];

export function humanizeColumn(col: string): string {
  const c = col.toLowerCase();
  for (const [re, label] of COLUMN_LABELS) if (re.test(c)) return label;
  // Fallback: drop id/eur/count suffixes, de-snake, capitalise — readable even for an unmapped column.
  const cleaned = col
    .replace(/_(eur|id)$/i, '')
    .replace(/_/g, ' ')
    .trim();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : col;
}

// Guess a display format from a column name, mirroring how the model picks one so the fallback reads like
// a normal report. Unknown → text (safe; the renderer shows the raw cell).
export function guessFormat(col: string): CellFormat {
  const c = col.toLowerCase();
  // A tally reads as a plain number even when its name also carries a GENERIC aggregate word like „total"
  // (e.g. total_count, total_contracts, total_bids) — check the count shape BEFORE the broad money pattern,
  // but only when there's no HARD currency token (eur/amount/spent/сума/…) that would make it a real sum.
  // „bids/offers/оферт" are counts too (a bid tally aliased total_bids/sum_offers must NOT read as euros).
  const hasCurrencyToken = /(eur|amount|spent|paid|стойност|похарчен|сума|разход)/.test(c);
  const isCountShape = /(count|contracts|number|броя?|договор|бр_|оферт|bids|offers)/.test(c);
  if (isCountShape && !hasCurrencyToken) return 'number';
  // Money needs a HARD currency token, or a bare aggregate word (sum/total/won) that is NOT count-shaped —
  // so `total_bids` / `sum_offers` can never fall through to euros just because they carry „total"/„sum".
  if (hasCurrencyToken || (/(sum|total|won)/.test(c) && !isCountShape)) return 'money';
  if (/(share|ratio|dial|дял|percent|процент|pct)/.test(c)) return 'percent';
  if (isCountShape) return 'number';
  if (/(date|signed|period|year|month|дата|период|година|месец)/.test(c)) return 'date';
  return 'text';
}

/** True when every value in column `i` across all rows is numeric (or null) — safe for a `totals` item. */
function isNumericColumn(result: QueryResult, i: number): boolean {
  return result.rows.every((row) => row[i] === null || typeof row[i] === 'number');
}

/**
 * Build a minimal report from THIS turn's results, or `{ ok: false }` when there is nothing to summarise
 * (no result carried any rows). Picks the LAST non-empty result — the model's final query is normally the
 * answer — and renders it as:
 *   - a `totals` block, when the result is a single row with ≥1 numeric column (the „one number" answer),
 *   - otherwise a `table` of the whole result (rankings, breakdowns, timeseries).
 * `question` is passed as the server-authoritative displayed question (not gated, not echoed by the model).
 */
export function buildFallbackReport(results: QueryResult[], question: string): BindResult {
  const last = [...results].reverse().find((r) => r.rows.length > 0);
  if (!last) return { ok: false, errors: ['no results to summarise'] };

  // Quality bar — the root cause of the „Division / 45" meaningless-report defect. This finalizer exists to
  // surface real FIGURES the model gathered but failed to format (see the module header). A SINGLE-row
  // result with NO numeric cell carries no figure: it is a stray dimensional probe (a lone CPV `division`
  // code the weak model queried but never meant to report) or a bare label — publishing it as an
  // authoritative „Справка" reads as scrap. Refuse; the turn then shows the rephrase affordance instead of
  // a hollow report. Multi-row results are left alone (a list of rows is at least substantive), and any
  // result with a numeric measure — a scalar total, an entity+figure row, a timeseries — still binds.
  // ponytail: keyed on a numeric cell, matching the schema (a `division` code is TEXT everywhere:
  // cpv-map.ts, reconcile-rollup grains); a dimension returned as an integer would slip past this, but the
  // real safeguard against that is the model not running dimension-only probes.
  const hasMeasure = last.rows.some((row) => row.some((v) => typeof v === 'number'));
  if (last.rows.length === 1 && !hasMeasure) {
    return {
      ok: false,
      errors: ['single-row result carries no measure — nothing quantitative to report'],
    };
  }

  // A `totals` block is the „one number" answer — use it only when the single row is ENTIRELY numeric.
  // A single row that also carries a text/label column (an entity name, a period) goes to a 1-row `table`
  // instead, so that context is preserved; a totals block would show the figures with no idea WHICH entity
  // they belong to (e.g. „91,8 млн. €" with „СОФЕКОСТРОЙ ЕАД" silently dropped).
  const singleAllNumericRow =
    last.rows.length === 1 && last.columns.every((_, i) => isNumericColumn(last, i));

  let blocks: EmitBlock[];
  const totalsItems = singleAllNumericRow
    ? last.columns.map((col, i) => {
        const fmt = guessFormat(col);
        return {
          label: humanizeColumn(col),
          ref: { resultId: last.handle, row: 0, col },
          // guessFormat picks 'percent' from the column NAME (share/дял); if the single-row value is
          // actually a raw sum/count (not a 0..1 ratio) that would render as an absurd „…%". Downgrade to
          // a plain number so the reader still sees the real figure.
          format:
            fmt === 'percent' && isImplausibleRatio(last.rows[0][i])
              ? ('number' as CellFormat)
              : fmt,
        };
      })
    : [];

  if (totalsItems.length > 0) {
    blocks = [{ type: 'totals', items: totalsItems }];
  } else {
    blocks = [
      {
        type: 'table',
        resultId: last.handle,
        columns: last.columns.map((col) => ({
          key: col,
          header: humanizeColumn(col),
          format: guessFormat(col),
        })),
      },
    ];
  }

  return bindReport({ title: FALLBACK_TITLE, question, blocks }, results, { question });
}
