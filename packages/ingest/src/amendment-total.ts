// #305 — amendment value double-count. ЦАИС ЕОП sometimes puts the announced NEW TOTAL contract value
// into the "change" field (`contractValueDifference` → `value_delta`), so the feed's
// `currentContractValue` (→ `value_after`) = `lastContractValue` + newTotal — the value is doubled. The
// source is internally consistent (`value_after = value_before + value_delta` at ~100% of rows), so the
// signal is semantic, not arithmetic: is `value_delta` an increment or a total?
//
// This module answers that from the основание free text, which the raw feed carries in three fields
// (changeDescription/changeReason/changeReasonDescription). The discriminator is the Bulgarian preposition
// in front of the figure: "на <N>" (to N) / "възлиза/става/обща стойност" ⇒ N is a TOTAL; "с <N>" (by N) /
// "увеличава се … с" ⇒ N is an INCREMENT. See docs/implementation-plans/305-amendment-value-double-count.md.
//
// Conservative by design: it only classifies when the text unambiguously confirms; otherwise it returns
// `none` and leaves the row to the arithmetic `annex_total_suspect` flag (Tier 1). It NEVER rewrites a
// value it cannot corroborate from text. Note: JS `\b`/`\w` are ASCII-only, so all boundaries/letters use
// Unicode (`\p{L}`, explicit non-letter boundary) with the `u` flag.

export type AmendmentValueTreatment =
  // The delta is an announced total; the true value_after is value_delta (double-count corrected).
  | { kind: 'total_restated'; correctedAfter: number }
  // An exact 2× (value_delta ≈ value_before): the "difference" field echoed the OLD value, so the value
  // is unchanged and value_after was doubled onto itself; the true value_after is value_before. Covers
  // currency re-denominations and non-value administrative annexes alike.
  | { kind: 'unchanged_restated'; correctedAfter: number }
  // The delta is a genuine increment already correctly applied — value_after is right; do NOT flag it.
  | { kind: 'genuine_increment' }
  // No text signal — leave to the arithmetic flag.
  | { kind: 'none' };

export interface AmendmentValueInput {
  valueBefore: number | null;
  valueAfter: number | null;
  valueDelta: number | null;
  currency: string | null;
  texts: Array<string | null | undefined>;
}

const REL_TOL = 0.005; // 0.5% — the text figure must be the SAME number as value_delta, allowing rounding.
const SPACES = '[\\d \\u00a0\\u202f]'; // digit or thousands separator (space / nbsp / narrow nbsp)
const NUMBER_RE = new RegExp(`\\d${SPACES}*(?:[.,]\\d{1,2})?`, 'g');
const WS = /[\s  ]/g;

// A left boundary: start-of-window or a non-letter, non-digit character (Unicode-aware — Cyrillic is a
// letter). Keywords that end the "before the figure" window signal how the figure should be read.
const B = '(?:^|[^\\p{L}\\d])';
const TOTAL_CTX = new RegExp(
  `${B}(?:възлиз\\p{L}*|възлез\\p{L}*|става|обща\\p{L}*\\s+(?:стойност|цена)|крайн\\p{L}*\\s+(?:стойност|цена)|нов\\p{L}*\\s+(?:обща\\s+)?(?:стойност|цена)|на)\\s*$`,
  'iu',
);
// The figure sits right after "от <N>" (the OLD value) or "с/със <N>" (an increment) — not a total.
const NOT_TOTAL_CTX = new RegExp(`${B}(?:от|с|със)\\s*$`, 'iu');
// "…с <N>" / "…със <N>" — N is an increment already applied.
const INCREMENT_CTX = new RegExp(`${B}(?:с|със)\\s*$`, 'iu');
// A wider veto on the "…на <N>" total match: Bulgarian "в размер на <N>" ("in the amount of N"),
// "ресурс … в размер на N", "допълнителни … на обща стойност N" name the CHANGE/added-work amount, not
// the new contract total — restating value_after := N there would be wrong (verified on the real corpus).
// Checked over a wider window than NOT_TOTAL_CTX because these markers sit a few words before the figure.
const TOTAL_VETO = /(?:в\s+размер|ресурс\p{L}*|допълнителн\p{L}*|увеличени\p{L}*|намалени\p{L}*)/iu;

function normalizeBgNumber(raw: string): number | null {
  const t = raw.replace(WS, '');
  const m = t.match(/^(\d+)(?:[.,](\d{1,2}))?$/);
  if (!m) return null;
  const value = Number(m[2] ? `${m[1]}.${m[2]}` : m[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) <= REL_TOL * Math.max(Math.abs(a), Math.abs(b));
}

// Does a figure ≈ `target` occur in `text` with the ~40 preceding chars matching `contextRe` and (when
// given) NOT matching `excludeRe`? Returns true on the first qualifying occurrence.
function figureInContext(
  text: string,
  target: number,
  contextRe: RegExp,
  excludeRe: RegExp | null,
  wideVetoRe: RegExp | null = null,
): boolean {
  NUMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBER_RE.exec(text)) !== null) {
    const n = normalizeBgNumber(m[0]);
    if (n === null || !approxEq(n, target)) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (excludeRe && excludeRe.test(before)) continue;
    // A wider veto looks further back (~55 chars) for "в размер"/"ресурс"/increment markers that make an
    // "…на <N>" an amount, not a total.
    if (wideVetoRe && wideVetoRe.test(text.slice(Math.max(0, m.index - 55), m.index))) continue;
    if (contextRe.test(before)) return true;
  }
  return false;
}

export function classifyAmendmentValue(input: AmendmentValueInput): AmendmentValueTreatment {
  const b = input.valueBefore;
  const a = input.valueAfter;
  const d = input.valueDelta;
  if (b === null || a === null || d === null || b <= 0 || a <= 0 || d <= 0) return { kind: 'none' };
  // Source self-consistency (a = b + d) is the precondition of the defect model.
  if (!approxEq(a, b + d)) return { kind: 'none' };
  // A single annex whose "increment" is at least the whole prior value (2b ≤ a < 10b). Below 2b is a
  // normal increase; ≥10b is a mis-key handled by #299's annex_suspect.
  if (a < 2 * b || a >= 10 * b) return { kind: 'none' };

  const text = input.texts.filter((t): t is string => !!t && t.trim() !== '').join('  ');

  // 1) The delta figure appears as an INCREMENT ("с <delta>") — the value is genuinely correct, don't
  //    touch it. Checked FIRST so an exact 2× that the text calls a real increase is not mis-restated.
  if (text && figureInContext(text, d, INCREMENT_CTX, null)) return { kind: 'genuine_increment' };

  // 2) The delta figure appears as a TOTAL ("на <delta>", "възлиза на …", "обща стойност … <delta>").
  //    The true value_after is the delta (the announced new total). TOTAL_VETO rejects "в размер на"/
  //    "ресурс"/increment phrasings that name the change amount, not the contract total.
  if (text && figureInContext(text, d, TOTAL_CTX, NOT_TOTAL_CTX, TOTAL_VETO)) {
    return { kind: 'total_restated', correctedAfter: d };
  }

  // 3) Exact 2× (value_delta ≈ value_before): the "difference" field just echoed the OLD value, so
  //    value_after = before + before double-counts an UNCHANGED value (currency re-denomination or a
  //    non-value administrative annex). ЗОП чл.116 caps a single amendment at +50%, so an exact +100% is a
  //    definitional defect, not a real increase — restate to value_before. Text-free by design; rule 1
  //    already exonerated any genuinely-announced increment, so this cannot understate a real one.
  if (approxEq(a, 2 * b)) {
    return { kind: 'unchanged_restated', correctedAfter: b };
  }

  return { kind: 'none' };
}

// The single value the ETL needs: the corrected value_after when the text confirms a double-count, else
// null (leave value_after as the source gave it).
export function restatedValueAfter(input: AmendmentValueInput): number | null {
  const t = classifyAmendmentValue(input);
  return t.kind === 'total_restated' || t.kind === 'unchanged_restated' ? t.correctedAfter : null;
}

export function isGenuineIncrement(input: AmendmentValueInput): boolean {
  return classifyAmendmentValue(input).kind === 'genuine_increment';
}

// Convenience for the ETL staging: the treatment label to store on the raw amendment row (NULL when no
// signal), and the corrected value_after (NULL unless a double-count was confirmed). A non-null treatment
// tells derive/normalize NOT to arithmetic-flag the row (it is either corrected or confirmed-genuine).
export function amendmentValueTreatment(input: AmendmentValueInput): {
  treatment: 'total_restated' | 'unchanged_restated' | 'genuine_increment' | null;
  restatedAfter: number | null;
} {
  const t = classifyAmendmentValue(input);
  return {
    treatment: t.kind === 'none' ? null : t.kind,
    restatedAfter:
      t.kind === 'total_restated' || t.kind === 'unchanged_restated' ? t.correctedAfter : null,
  };
}
