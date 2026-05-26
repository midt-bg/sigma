// Sigma — display formatting. ALL hand-rolled: workerd does not fully carry the `bg-BG` locale data
// that Intl.NumberFormat / Intl.DateTimeFormat need, so we never rely on Intl for Bulgarian output.
// Conventions: decimal comma, space thousands separator, Bulgarian magnitude words (хил./млн./млрд.),
// EUR only (the corpus is converted to amount_eur upstream; no FX or лв. at display time).

const EM_DASH = '—'; // shown when a figure is genuinely absent (never a fabricated 0)
const MINUS = '−'; // U+2212 minus, not a hyphen — pairs with tabular-nums

const MONTHS_BG = [
  'януари', 'февруари', 'март', 'април', 'май', 'юни',
  'юли', 'август', 'септември', 'октомври', 'ноември', 'декември',
];

/** Format a number to `dp` decimals with a comma decimal sep; optionally drop a trailing „,0". */
function dec(n: number, dp: number, stripZeros: boolean): string {
  let s = n.toFixed(dp);
  if (stripZeros && s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s.replace('.', ',');
}

/**
 * EUR money in Bulgarian magnitude tiers, e.g. `640 €` · `412 хил. €` · `187 млн. €` · `4,58 млрд. €`.
 * млн. → one decimal (trailing „,0" dropped); млрд. → two decimals under 10, one at/above (so „50,8
 * млрд." and „4,58 млрд." both read right). Returns „—" for null/NaN — callers suppress suspect rows
 * (NULL amount_eur) upstream rather than pass a 0 here.
 */
export function money(eur: number | null | undefined): string {
  if (eur == null || !Number.isFinite(eur)) return EM_DASH;
  const neg = eur < 0;
  const v = Math.abs(eur);
  let body: string;
  if (v < 1000) body = `${Math.round(v)} €`;
  else if (v < 999_500) body = `${Math.round(v / 1e3)} хил. €`;
  else if (v < 999_500_000) body = `${dec(v / 1e6, 1, true)} млн. €`;
  else {
    const b = v / 1e9;
    body = `${b < 10 ? dec(b, 2, false) : dec(b, 1, true)} млрд. €`;
  }
  return neg ? `${MINUS}${body}` : body;
}

/** Integer with a space thousands separator: `190429` → `190 429`. */
export function count(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return EM_DASH;
  const neg = n < 0;
  const s = Math.abs(Math.round(n))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return neg ? `${MINUS}${s}` : s;
}

/** A ratio (0–1) as a percentage: `0.453` → `45,3%`. Default 1 dp, trailing „,0" dropped (`0.78` → `78%`). */
export function pct(ratio: number | null | undefined, dp = 1): string {
  if (ratio == null || !Number.isFinite(ratio)) return EM_DASH;
  return `${dec(ratio * 100, dp, true)}%`;
}

/** Signed percentage delta with an explicit sign: `-0.233` → `−23,3%`, `0.05` → `+5%`. */
export function signedPct(ratio: number | null | undefined, dp = 1): string {
  if (ratio == null || !Number.isFinite(ratio)) return EM_DASH;
  const body = pct(Math.abs(ratio), dp);
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
export function periodRange(first: string | null | undefined, last: string | null | undefined): string {
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
 * The canonical, comparable EUR value of a contract for lists/leaderboards/sums: `amount_eur` —
 * already current-when-an-annex-legitimately-raised-it, else signing, and NULL for value_suspect or
 * a foreign row without an FX rate. Returns null so the caller renders the „данните се преглеждат"
 * note instead of a number. The estimated→signing→current timeline (contract page) uses the
 * separate *_eur fields directly.
 */
export function contractValue(row: { amount_eur: number | null }): number | null {
  return row.amount_eur ?? null;
}
