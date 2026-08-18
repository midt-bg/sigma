import { CPV_SECTORS } from '@sigma/config';
import { count, money, pct } from '@sigma/shared';

// Weekly, zero-LLM starter prompts for the assistant dock empty state. ONE writer: this job (the
// sigma-etl weekly cron). ONE reader: apps/web's assistant.prompts.tsx loader. It runs deterministic
// SQL over D1 and fills Bulgarian sentence templates — no model, no feed text in the send payload.
//
// LOAD-BEARING ASSUMPTION (documented per spec §"Money policy" / §"Data-soundness guards"):
// the slot sums use `amount_eur IS NOT NULL` only, with NO `value_flag` gate, so they reconcile
// *exactly* with `home_totals.value_eur` (= raw SUM(amount_eur) over non-NULL rows,
// scripts/refresh-slice.sql:1341) and the explorer. We inherit the upstream `amount_eur` posture by
// design; soundness depends on that upstream derivation, guarded here by (a) a runtime reconciliation
// tripwire that logs `etl_prompt_reconcile_mismatch` on drift and (b) the slot-1 outlier guard, which
// suppresses a named top-1 pick that amplifies a single bad row a sum would merely dilute.
//
// The NAMED slot-1 pick additionally gates on `value_flag = 'ok'` (stricter than the reconciling
// `amount_eur IS NOT NULL`): a named headline must never attach an authority to a row the pipeline
// flagged as suspect. The aggregate slots keep the wider basis so the totals still reconcile.

const CPV_LABELS = new Map(CPV_SECTORS.map((s) => [s.code, s.label]));

// Windows the job tries in order. Slots 1/2/4 widen when empty / under the slot-4 floor; the labels
// always name the ACTUAL window used.
const WINDOW_DAYS = [7, 14, 30] as const;

// Slot-4 needs a minimum sample before a single-offer share is worth showing.
const SLOT4_MIN_TOTAL = 20;

// Slot-1 outlier guard: suppress the authority NAME when the top contract dwarfs the runner-up.
const SLOT1_OUTLIER_RATIO = 10;

// Authority-name display cap (defence-in-depth + layout safety; React already escapes).
const NAME_MAX_CHARS = 80;

export const SLOT1_SQL = `
SELECT a.name AS authority, c.amount_eur AS amount_eur, c.value_flag AS value_flag,
       substr(t.cpv_code, 1, 2) AS div
FROM contracts c
JOIN tenders t ON t.id = c.tender_id
JOIN authorities a ON a.id = t.authority_id
WHERE c.amount_eur IS NOT NULL AND c.value_flag = 'ok'
  AND c.signed_at > date(?1, '-' || ?2 || ' day') AND c.signed_at <= ?1
ORDER BY c.amount_eur DESC
LIMIT 5;
`.trim();

export const SLOT2_SQL = `
SELECT substr(t.cpv_code, 1, 2) AS div, SUM(c.amount_eur) AS eur, COUNT(*) AS n
FROM contracts c
JOIN tenders t ON t.id = c.tender_id
WHERE c.amount_eur IS NOT NULL AND t.cpv_code <> ''
  AND c.signed_at > date(?1, '-' || ?2 || ' day') AND c.signed_at <= ?1
GROUP BY div
ORDER BY eur DESC
LIMIT 1;
`.trim();

export const SLOT3_SQL = `
SELECT COUNT(*) AS n, COALESCE(SUM(c.amount_eur), 0) AS eur
FROM contracts c
WHERE c.amount_eur IS NOT NULL
  AND c.signed_at > date(?1, '-' || ?2 || ' day') AND c.signed_at <= ?1;
`.trim();

export const SLOT4_SQL = `
SELECT SUM(CASE WHEN c.bids_received = 1 THEN 1 ELSE 0 END) AS single, COUNT(*) AS total
FROM contracts c
JOIN tenders t ON t.id = c.tender_id
WHERE c.amount_eur IS NOT NULL
  AND c.bids_received IS NOT NULL AND c.bids_received >= 1
  AND t.procedure_type <> 'неизвестна'
  AND c.signed_at > date(?1, '-' || ?2 || ' day') AND c.signed_at <= ?1;
`.trim();

const RECONCILE_SQL =
  'SELECT COALESCE(SUM(amount_eur), 0) AS eur FROM contracts WHERE amount_eur IS NOT NULL';

interface PromptRow {
  slot: number;
  label: string;
  sendQuery: string;
  signal: string;
  // The ACTUAL window this slot used (slots 1/2/4 may have widened 7→14→30). Stored verbatim so the
  // window_from/window_to columns match the label, not a fixed base window.
  windowFrom: string;
  windowTo: string;
}

interface Slot1Row {
  authority: string | null;
  amount_eur: number;
  value_flag: string;
  div: string | null;
}

interface Slot2Row {
  div: string | null;
  eur: number;
  n: number;
}

interface Slot3Row {
  n: number;
  eur: number;
}

interface Slot4Row {
  single: number | null;
  total: number;
}

/**
 * Sanitize a feed-sourced authority name for display: NFC-normalize, strip zero-width / bidi-override
 * controls (U+200B–200F, U+202A–202E, U+2028/U+2029), collapse whitespace, and cap at ~80 chars with
 * an ellipsis. NOTE: it does NOT strip HTML — XSS-safety relies on React escaping at the one render
 * site (AssistantEmptyState renders `label` as a text child); a non-React render of `label` would be
 * unsafe. This sanitizer is defence-in-depth (bidi/zero-width spoofing) + layout safety, not the XSS
 * boundary itself.
 */
export function sanitizeName(s: string): string {
  const stripped = s
    .normalize('NFC')
    // zero-width (U+200B–200F), bidi overrides (U+202A–202E), line/para separators (U+2028/U+2029)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2028\u2029]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length <= NAME_MAX_CHARS) return stripped;
  return `${stripped.slice(0, NAME_MAX_CHARS).trimEnd()}…`;
}

/**
 * Slot-1 outlier guard: true when the top contract dwarfs the runner-up (top >= K × second), so the
 * job suppresses the authority NAME and emits a number-free fallback for slot 1. With fewer than two
 * rows there is no runner-up to compare against, so the guard does not trip.
 */
export function slot1OutlierSuppressed(top: number, second: number | undefined): boolean {
  if (second === undefined) return false;
  return top >= SLOT1_OUTLIER_RATIO * second;
}

export function buildSlot1(rows: readonly Slot1Row[], from: string, to: string): PromptRow | null {
  const top = rows[0];
  if (!top) return null;
  const send = `Покажи най-голямата поръчка, подписана в периода ${from}–${to}.`;
  const suppressed = slot1OutlierSuppressed(top.amount_eur, rows[1]?.amount_eur);
  if (suppressed) {
    return {
      slot: 1,
      label: `Най-голяма поръчка, подписана ${from}–${to}: ${money(top.amount_eur)}`,
      sendQuery: send,
      signal: 'biggest_contract_outlier_suppressed',
      windowFrom: from,
      windowTo: to,
    };
  }
  const name = top.authority ? sanitizeName(top.authority) : '—';
  const sectorLabel = top.div ? (CPV_LABELS.get(top.div) ?? '—') : '—';
  return {
    slot: 1,
    label: `Най-голяма поръчка, подписана ${from}–${to}: ${money(top.amount_eur)} — ${name} (${sectorLabel})`,
    sendQuery: send,
    signal: 'biggest_contract',
    windowFrom: from,
    windowTo: to,
  };
}

export function buildSlot2(row: Slot2Row | null, from: string, to: string): PromptRow | null {
  if (!row || row.div === null) return null;
  const sectorLabel = CPV_LABELS.get(row.div);
  if (sectorLabel === undefined) return null;
  return {
    slot: 2,
    label: `Сектор с най-много средства ${from}–${to}: ${sectorLabel} — ${money(row.eur)} по ${count(row.n)} договора`,
    sendQuery: `Кои изпълнители спечелиха най-много в ${sectorLabel} за периода ${from}–${to}?`,
    signal: 'top_sector',
    windowFrom: from,
    windowTo: to,
  };
}

export function buildSlot3(row: Slot3Row, from: string, to: string): PromptRow {
  return {
    slot: 3,
    label: `Подписани ${from}–${to}: ${count(row.n)} договора за ${money(row.eur)}`,
    sendQuery: `Покажи договорите, подписани в периода ${from}–${to}.`,
    signal: 'window_activity',
    windowFrom: from,
    windowTo: to,
  };
}

export function buildSlot4(row: Slot4Row | null, from: string, to: string): PromptRow | null {
  if (!row || row.total < SLOT4_MIN_TOTAL) return null;
  const single = row.single ?? 0;
  return {
    slot: 4,
    label: `${count(single)} от ${count(row.total)} договора с известен брой оферти (${pct(single / row.total)}) са с една оферта, ${from}–${to}`,
    sendQuery: `Какъв е делът на договорите с една оферта, подписани в периода ${from}–${to}?`,
    signal: 'single_offer_share',
    windowFrom: from,
    windowTo: to,
  };
}

/**
 * First calendar day actually included by the slot window, for display labels. The SQL lower bound is
 * STRICT (`signed_at > date(asOf,'-Nd')`), so `date(asOf,'-Nd')` itself is excluded and the earliest
 * included day is `asOf - days + 1`. Returning that here keeps the `${from}–${to}` label honest: a
 * reader who sees a contract dated exactly on the displayed start will find it in the results.
 */
function windowFrom(asOf: string, days: number): string {
  const to = new Date(`${asOf}T00:00:00Z`);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - days + 1);
  return from.toISOString().slice(0, 10);
}

function log(event: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', event, ...extra }));
}

/**
 * Refresh the four assistant starter prompts. Reads `as_of` from `home_totals`, runs deterministic
 * per-slot SQL (widening the window for the empty-prone slots), formats Bulgarian templates, and
 * UPSERTs each produced slot. UPSERT-only — never CREATE TABLE here. Per-slot try/catch leaves the
 * prior row intact on failure. `now` is injectable for tests; it stamps `refreshed_at` only — the
 * window is anchored on `home_totals.as_of`, never on wall-clock.
 */
export async function generateSuggestedPrompts(db: D1Database, now = new Date()): Promise<void> {
  const totals = await db
    .prepare('SELECT value_eur AS value_eur, as_of AS as_of FROM home_totals WHERE id = 1')
    .first<{ value_eur: number | null; as_of: string | null }>();

  const asOf = totals?.as_of ?? null;
  if (asOf === null) {
    log('etl_prompts_no_asof');
    return;
  }

  // Reconciliation tripwire (non-fatal): the slot sums share home_totals' money posture by design, so
  // a drift beyond ε signals an upstream amount_eur regression we want visible, not silently served.
  const reconcile = await db.prepare(RECONCILE_SQL).first<{ eur: number }>();
  const summed = reconcile?.eur ?? 0;
  const headline = totals?.value_eur ?? 0;
  if (Math.abs(summed - headline) > 1) {
    log('etl_prompt_reconcile_mismatch', { summed, headline, diff: summed - headline });
  }

  const refreshedAt = now.toISOString();
  const baseFrom = windowFrom(asOf, WINDOW_DAYS[0]);
  const prompts: PromptRow[] = [];

  // Slot 1 — biggest signed contract (named display, outlier-guarded). Widen until a row appears.
  let slot1: PromptRow | null = null;
  for (const days of WINDOW_DAYS) {
    const from = windowFrom(asOf, days);
    const rows = await db.prepare(SLOT1_SQL).bind(asOf, days).all<Slot1Row>();
    const list = rows.results ?? [];
    const top = list[0];
    if (top) {
      log('etl_prompt_slot1_pick', {
        amount: top.amount_eur,
        valueFlag: top.value_flag,
        ratio: list[1] ? top.amount_eur / list[1].amount_eur : null,
        windowDays: days,
      });
      slot1 = buildSlot1(list, from, asOf);
      break;
    }
  }
  if (slot1) prompts.push(slot1);

  // Slot 2 — top CPV division by signed spend. Widen until a known sector appears.
  let slot2: PromptRow | null = null;
  for (const days of WINDOW_DAYS) {
    const from = windowFrom(asOf, days);
    const row = await db.prepare(SLOT2_SQL).bind(asOf, days).first<Slot2Row>();
    const built = buildSlot2(row ?? null, from, asOf);
    if (built) {
      slot2 = built;
      break;
    }
  }
  if (slot2) prompts.push(slot2);

  // Slot 3 — window activity (structurally non-empty). 7-day window only.
  {
    const row = await db.prepare(SLOT3_SQL).bind(asOf, WINDOW_DAYS[0]).first<Slot3Row>();
    prompts.push(buildSlot3(row ?? { n: 0, eur: 0 }, baseFrom, asOf));
  }

  // Slot 4 — single-offer share with a sample floor. Widen until total >= 20; else drop the slot.
  let slot4: PromptRow | null = null;
  for (const days of WINDOW_DAYS) {
    const from = windowFrom(asOf, days);
    const row = await db.prepare(SLOT4_SQL).bind(asOf, days).first<Slot4Row>();
    const built = buildSlot4(row ?? null, from, asOf);
    if (built) {
      slot4 = built;
      break;
    }
  }
  if (slot4) prompts.push(slot4);

  // UPSERT each produced slot independently; one failure leaves that slot's prior row untouched.
  let written = 0;
  let failed = 0;
  for (const prompt of prompts) {
    try {
      await db
        .prepare(
          `INSERT INTO assistant_prompts (slot, label, send_query, signal, as_of, window_from, window_to, refreshed_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT(slot) DO UPDATE SET
             label = excluded.label,
             send_query = excluded.send_query,
             signal = excluded.signal,
             as_of = excluded.as_of,
             window_from = excluded.window_from,
             window_to = excluded.window_to,
             refreshed_at = excluded.refreshed_at`,
        )
        .bind(
          prompt.slot,
          prompt.label,
          prompt.sendQuery,
          prompt.signal,
          asOf,
          prompt.windowFrom,
          prompt.windowTo,
          refreshedAt,
        )
        .run();
      written += 1;
    } catch (error) {
      failed += 1;
      console.log(
        JSON.stringify({
          level: 'error',
          event: 'etl_prompt_slot_failed',
          slot: prompt.slot,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  log('etl_prompts_written', { written, failed, slots: prompts.length });
}
