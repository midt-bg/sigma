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
  // #305 — the text-free exact-2× rule leans on ЗОП чл.116 (a single amendment caps at +50%, so +100% is a
  // defect not a real increase). чл.116 does NOT bind contracts procured outside ЗОП (exception contracts),
  // where a genuine +100% is legal — so for those, only the text-confirmed rules may restate. NULL/false =
  // in-scope of ЗОП (the safe default: apply the rule).
  outsideZop?: boolean | null;
}

const REL_TOL = 0.005; // 0.5% — the text figure must be the SAME number as value_delta, allowing rounding.
// #305 — capture a full number token that may group thousands with space/nbsp/narrow-nbsp OR with '.'/','
// (BG "1.234,56", US "1,234.56"); normalizeBgNumber disambiguates the decimal mark below. The token must
// END on a digit so a trailing sentence period ("…100. Нов срок") is not swallowed into the number.
const NUMBER_RE = /\d[\d\u0020\u00a0\u202f.,]*\d|\d/g;
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

// #307 — a total restatement needs a MONETARY anchor bracketing the figure. Bare "на <N>" is not a money
// signal ("на" also precedes days, article numbers, quantities), so "…удължава на 200 дни" would otherwise
// rewrite the value with a day count. Accept the figure only when a value keyword sits immediately before
// it (MONEY_BEFORE) OR a currency unit follows it (MONEY_AFTER). On the real corpus the value keyword is
// usually far from the figure ("…ще възлезе на 539 240.00 лв."), so the currency unit after the number is
// the load-bearing anchor. No ASCII \b (Cyrillic).
const MONEY_BEFORE = /(?:стойност|цена)\p{L}*\s*$/iu;
const MONEY_AFTER = /(?:^|[^\p{L}])(?:лв\.?|лева|лев|bgn|eur|евро|euro|€|usd|\$)(?![\p{L}])/iu;
// #307 — MONEY_AFTER scans the whole ~60-char window, so a sentence that names both a term and a value
// ("…удължава на 200 дни, стойността остава 100 лв.") lets a downstream currency token anchor a figure
// that is actually a day count. A non-monetary unit sitting IMMEDIATELY after the figure (days, months,
// years, count, percent) overrides any currency further along: the figure is a duration/quantity, never
// the contract value. Anchored at ^ against the post-figure slice so only the immediate suffix counts.
// Real BG annexes almost never write the unit bare — the term is qualified ("работни дни", "календарни
// дни") — so allow one optional adjective word (and an optional spelled-out number in brackets, "200
// (двеста) дни") between the figure and the unit, and cover area/volume/weight units too. Errs safe: a
// false veto only downgrades a row to `none`, dropping it to the arithmetic annex_total_suspect flag
// rather than publishing a substituted value.
const NON_MONEY_UNIT_AFTER =
  /^\s*(?:\([^)]*\)\s*)?(?:\p{L}+\s+)?(?:дни|дн\.|к\.\s?д\.|р\.\s?д\.|месец\p{L}*|години|год\.|броя|бр\.|кв\.?\s?м|куб\.?\s?м|тона|литра|%|процент\p{L}*)/iu;

// #307 — the exact-2× "unchanged" restatement (rule 3) may only fire WITH a positive textual signal that
// the value did not really change: a currency re-denomination that mechanically doubled the figure, or an
// explicit "unchanged / non-material" phrasing. Absent any signal the row returns `none` and falls to the
// arithmetic annex_total_suspect flag (exclude), rather than silently halving a possibly-legitimate
// ЗОП чл.116 ал.1 т.1 in-scope +100% (a pre-announced option clause `outsideZop` cannot model).
// #307 — the anchor is the "X в евро" re-denomination phrasing (`лев… в евро`), NOT a bare "в евро": a
// payment-currency clause ("Плащанията…се извършват в евро…") says nothing about an unchanged total and
// would silently halve a real doubling. The bare form was also redundant — the 189325 fixture
// ("…се променя от лева в евро") is already caught by the `лев… в евро` alternative.
const RESTATE_UNCHANGED_CTX =
  /(?:лев\p{L}*\s+в\s+евро|деноминаци\p{L}*|не\s*се\s+промен\p{L}*|остава\p{L}*\s+непромен\p{L}*|без\s+промяна|несъществен\p{L}*)/iu;

function normalizeBgNumber(raw: string): number | null {
  let t = raw.replace(WS, '');
  // #305 — when BOTH '.' and ',' appear the number uses one as a thousands separator and the other as the
  // decimal mark (BG "1.234,56" or US "1,234.56"). The LAST-occurring separator is the decimal; strip the
  // other (thousands) and normalise the decimal to '.'. Single-separator numbers keep the existing
  // ≤2-fraction-digit convention (the space-thousands corpus: "539 240.00", "286 694,00").
  if (t.includes('.') && t.includes(',')) {
    const decimalChar = t.lastIndexOf('.') > t.lastIndexOf(',') ? '.' : ',';
    const thousandsChar = decimalChar === '.' ? ',' : '.';
    t = t.split(thousandsChar).join('');
    if (decimalChar === ',') t = t.replace(',', '.');
  }
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
  requireMoneyAnchor = false,
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
    if (!contextRe.test(before)) continue;
    // #307 — a total needs a monetary marker bracketing the figure, else a bare "…на <N>" matches a
    // non-monetary number (days, article nos.) that coincidentally ≈ the target. A value keyword right
    // before, OR a currency unit within the ~60 chars after, qualifies.
    if (requireMoneyAnchor) {
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
      // A non-monetary unit immediately after the figure (days/months/years/count/%) vetoes it before
      // a downstream currency token can wrongly anchor it as money (#307).
      if (NON_MONEY_UNIT_AFTER.test(after)) continue;
      if (!MONEY_BEFORE.test(before) && !MONEY_AFTER.test(after)) continue;
    }
    return true;
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
  //    "ресурс"/increment phrasings that name the change amount, not the contract total. A monetary anchor
  //    is REQUIRED (#307) so a bare "…на <N>" over a non-monetary number (days, article nos.) is rejected.
  if (text && figureInContext(text, d, TOTAL_CTX, NOT_TOTAL_CTX, TOTAL_VETO, true)) {
    return { kind: 'total_restated', correctedAfter: d };
  }

  // 3) Exact 2× (value_delta ≈ value_before): the "difference" field just echoed the OLD value, so
  //    value_after = before + before double-counts an UNCHANGED value (currency re-denomination or a
  //    non-value administrative annex). This restatement to value_before is only SAFE with a positive text
  //    signal (#307): ЗОП чл.116 ал.1 т.1 permits a genuine in-scope +100% via a pre-announced option/review
  //    clause that `outsideZop` cannot see, so a text-free rewrite could silently HALVE a legitimate value.
  //    Require either a "value unchanged / re-denomination" phrasing (RESTATE_UNCHANGED_CTX) or the
  //    before-value itself announced as the new total. Absent any signal, return `none` and let the
  //    arithmetic annex_total_suspect flag EXCLUDE the row (an honest gap beats a silent corruption).
  //    Still skipped for outside-ЗОП exception contracts, where a real +100% is legal.
  if (approxEq(a, 2 * b) && !input.outsideZop && text) {
    if (
      RESTATE_UNCHANGED_CTX.test(text) ||
      figureInContext(text, b, TOTAL_CTX, NOT_TOTAL_CTX, TOTAL_VETO, true)
    ) {
      return { kind: 'unchanged_restated', correctedAfter: b };
    }
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
