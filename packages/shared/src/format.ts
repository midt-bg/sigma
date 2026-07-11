// Sigma — display formatting. ALL hand-rolled: workerd does not fully carry the `bg-BG` locale data
// that Intl.NumberFormat / Intl.DateTimeFormat need, so we never rely on Intl for Bulgarian output.
// Conventions: decimal comma, non-breaking-space thousands separator, Bulgarian magnitude words (хил./млн./млрд.),
// EUR only (the corpus is converted to amount_eur upstream; no FX or лв. at display time).

const EM_DASH = '—'; // shown when a figure is genuinely absent (never a fabricated 0)
const MINUS = '−'; // U+2212 minus, not a hyphen — pairs with tabular-nums
const NBSP = ' '; // non-breaking space — keeps a figure from wrapping across the thousands/word gap

const MONTHS_BG = [
  'януари',
  'февруари',
  'март',
  'април',
  'май',
  'юни',
  'юли',
  'август',
  'септември',
  'октомври',
  'ноември',
  'декември',
];

/** Format a number to `dp` decimals with a comma decimal sep; optionally drop a trailing „,0". */
function dec(n: number, dp: number, stripZeros: boolean): string {
  let s = n.toFixed(dp);
  if (stripZeros && s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s.replace('.', ',');
}

function rounded(n: number, dp: number): number {
  return Number(n.toFixed(dp));
}

function moneyBody(eur: number, withUnit: boolean): string {
  const v = Math.abs(eur);
  const roundedEur = Math.round(v);
  const u = withUnit ? `${NBSP}€` : '';
  let body: string;
  if (roundedEur < 1000) body = `${roundedEur}${u}`;
  else if (Math.round(v / 1e3) < 1000) body = `${Math.round(v / 1e3)}${NBSP}хил.${u}`;
  else if (rounded(v / 1e6, 1) < 1000) body = `${dec(v / 1e6, 1, true)}${NBSP}млн.${u}`;
  else {
    const b = v / 1e9;
    const useTwoDecimals = rounded(b, 2) < 10;
    body = `${useTwoDecimals ? dec(b, 2, false) : dec(b, 1, true)}${NBSP}млрд.${u}`;
  }
  return body;
}

/**
 * EUR money in Bulgarian magnitude tiers, e.g. `640 €` · `412 хил. €` · `187 млн. €` · `4,58 млрд. €`.
 * млн. → one decimal (trailing „,0" dropped); млрд. → two decimals under 10, one at/above (so „50,8
 * млрд." and „4,58 млрд." both read right). Returns „—" for null/NaN — callers suppress suspect rows
 * (NULL amount_eur) upstream rather than pass a 0 here.
 */
export function money(eur: number | null | undefined): string {
  if (eur == null || !Number.isFinite(eur)) return EM_DASH;
  const roundedEur = Math.round(Math.abs(eur));
  const body = moneyBody(eur, true);
  return eur < 0 && roundedEur !== 0 ? `${MINUS}${body}` : body;
}

/**
 * Like `money()` but without the trailing `€` — for table cells where the column header already
 * carries `(€)`. E.g. `412 хил.` instead of `412 хил. €`.
 */
export function moneyBare(eur: number | null | undefined): string {
  if (eur == null || !Number.isFinite(eur)) return EM_DASH;
  const roundedEur = Math.round(Math.abs(eur));
  const body = moneyBody(eur, false);
  return eur < 0 && roundedEur !== 0 ? `${MINUS}${body}` : body;
}

/** Integer with a space thousands separator: `190429` → `190 429`. */
export function count(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return EM_DASH;
  const neg = n < 0;
  const s = Math.abs(Math.round(n))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return neg ? `${MINUS}${s}` : s;
}

/** A ratio (0–1) as a percentage: `0.453` → `45,3%`. Default 1 dp, trailing „,0" dropped (`0.78` → `78%`). */
export function pct(ratio: number | null | undefined, dp = 1): string {
  if (ratio == null || !Number.isFinite(ratio)) return EM_DASH;
  const roundedMagnitude = rounded(Math.abs(ratio) * 100, dp);
  const body = `${dec(Math.abs(ratio) * 100, dp, true)}%`;
  return ratio < 0 && roundedMagnitude !== 0 ? `${MINUS}${body}` : body;
}

/** Signed percentage delta with an explicit sign: `-0.233` → `−23,3%`, `0.05` → `+5%`. */
export function signedPct(ratio: number | null | undefined, dp = 1): string {
  if (ratio == null || !Number.isFinite(ratio)) return EM_DASH;
  const roundedMagnitude = rounded(Math.abs(ratio) * 100, dp);
  const body = pct(Math.abs(ratio), dp);
  if (roundedMagnitude === 0) return body;
  if (ratio < 0) return `${MINUS}${body}`;
  if (ratio > 0) return `+${body}`;
  return body;
}

/** ISO date → `DD.MM.YYYY` (`2024-10-14` → `14.10.2024`). Tolerates a datetime prefix. */
export function date(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/** ISO date → `октомври 2024` (hand-rolled month names, no Intl). */
export function monthYear(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS_BG[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** ISO date → `1 октомври 2024 г.` (long Bulgarian form, used on the contract page). */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS_BG[Number(m[2]) - 1] ?? m[2]} ${m[1]} г.`;
}

/** A period like `юли 2020 — май 2026` from first/last ISO dates. */
export function periodRange(
  first: string | null | undefined,
  last: string | null | undefined,
): string {
  if (!first && !last) return EM_DASH;
  if (first && last) return `${monthYear(first)} — ${monthYear(last)}`;
  return monthYear(first ?? last);
}

/** ЕИК passthrough (digits kept verbatim — source truth; the UI renders it in mono). */
export function eik(value: string | null | undefined): string {
  return value ? value.trim() : '';
}

/** УНП passthrough — kept exactly as published (format `NNNNN-YYYY-NNNN`); the UI renders it in mono. */
export function unp(value: string | null | undefined): string {
  return value ? value.trim() : '';
}

/**
 * Parse the consortium `bidders.name` string into a participants view.
 *
 * The upstream procurement feed (AOP / storage.eop.bg) gives us a single `contractor_name` string
 * for an award;
 * for an обединение / ДЗЗД that string concatenates the members. Three real shapes appear in the
 * production dataset (n=3736 consortium rows as of 2026-06):
 *
 *   - `list`  (3,366 rows, ~90 %): clean `;`-separated names, e.g. „A ООД; B ЕООД; C АД".
 *                                 Trimmed, deduped (same name often repeats); rendered as a list.
 *   - `prose` (    4 rows, ~0 %):  free-text dump like „Съдружници … са следните лица: 1. … 40 %;
 *                                 2. … 60 %" — splitting on `;` butchers it, so we keep it verbatim.
 *   - `none`  (  370 rows, ~10 %): single name with the ДЗЗД/ОБЕДИНЕНИЕ keyword inline; nothing
 *                                 useful to break out. Caller hides the participants section.
 *
 * `null` is the explicit „nothing-to-show" signal so the renderer can skip the whole block instead
 * of emitting an empty heading. Resolving each member name → ЕИК is parked on the Trade Register
 * backfill (docs/core-scope.md — parked Trade Register pipeline); until that lands the caller stamps every
 * participant with `ЕИК неустановен`.
 */
export type ConsortiumMembership =
  | { kind: 'list'; members: string[] } // clean A; B; C — trimmed, deduped, length ≥ 2
  | { kind: 'prose'; raw: string }; // free-text dump with embedded partner enumeration

const PROSE_RE = /съдружник|следните лица|дялов(?:о)? участие/i;

export function parseConsortiumMembers(name: string): ConsortiumMembership | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (PROSE_RE.test(trimmed)) return { kind: 'prose', raw: trimmed };
  const parts = trimmed
    .split(';')
    .map((s) => cleanName(s))
    .filter(Boolean);
  const unique = Array.from(new Set(parts));
  if (unique.length < 2) return null;
  return { kind: 'list', members: unique };
}

export function isNaturalPersonProfileName(name: string): boolean {
  const normalized = name.trim().toUpperCase();
  return normalized.startsWith('ЕТ ') || normalized.startsWith('ET ');
}

/**
 * Display name for a winning entity. A consortium row holds a `;`-joined member list → show the
 * first member + „и др." (the **Обединение** badge is rendered separately by the caller). Companies
 * pass through unchanged — source names keep their quoting/casing, because that is the source truth.
 */
export function entityName(name: string, kind: 'company' | 'consortium'): string {
  if (kind === 'consortium' && name.includes(';')) {
    const first = (name.split(';')[0] ?? '').trim();
    if (first) return `${first} и др.`;
  }
  return name;
}

/**
 * Bulgarian count word: returns `one` when n ends in 1 but not 11 (1, 21, 101… → договор), else
 * `many` (2, 11, 17… → договора). Returns ONLY the word — format the number separately with count().
 * Use as plural(n, 'договор', 'договора') / plural(n, 'съвпадение', 'съвпадения').
 */
export function plural(n: number, one: string, many: string): string {
  return n % 10 === 1 && n % 100 !== 11 ? one : many;
}

/**
 * Normalize a registry display name for the UI. Conservative — a no-op on already-clean names:
 * unifies curly/guillemet double-quotes to a straight " , collapses the space-before-closing-quote
 * that hugs a legal-form suffix („СОФАРМА ТРЕЙДИНГ "АД" → „СОФАРМА ТРЕЙДИНГ" АД"), and drops a single
 * edge (leading/trailing) unbalanced quote. Leaves legitimate quoting around a token
 * (ДЕТСКА ГРАДИНА "ЗДРАВЕЦ") alone.
 */
export function cleanName(raw: string): string {
  let s = raw.trim().replace(/[“”„«»]/g, '"');
  // ' "АД' (space, quote, legal-form suffix) → '" АД': close the quote on the preceding word.
  // Negative lookahead, not \b — JS \b is ASCII-only and never fires next to Cyrillic letters.
  s = s.replace(/\s+"(\s*)(ЕАД|ЕООД|ООД|АД)(?![А-Яа-яA-Za-z])/g, '" $2');
  // A single unbalanced trailing/leading quote left over: drop it.
  if ((s.match(/"/g)?.length ?? 0) % 2 === 1) s = s.replace(/^"|"$/, '');
  return s;
}
