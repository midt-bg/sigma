import { cleanName } from './format';

/**
 * Deterministic match key for a Bulgarian company name — the libel-safety surface of the
 * „свързани лица" matcher (docs/spec/related-persons-foundation.md §5).
 *
 * Bulgarian trade names are nationally unique on the FULL фирма *including* legal form
 * (ЗТРРЮЛНЦ чл.21 т.7 / ТЗ чл.7), so an exact key match = the same legal entity. To keep that
 * guarantee the key folds ONLY presentation noise and preserves every distinguishing token:
 *
 *   - case (`toUpperCase`), collapsed whitespace, and quote glyphs (curly/guillemet → straight
 *     via `cleanName`, then turned into a SPACE — a quote separates tokens, so dropping it outright
 *     would merge `АБ"ВГ` → `АБВГ` and collide with a genuinely distinct `АБВГ`; mapping it to a space
 *     keeps `АБ ВГ` distinct while still folding surrounding quotes away at the trim/collapse step).
 *
 * It deliberately does NOT: transliterate Cyrillic↔Latin homoglyphs, fold „и"↔„&", strip the
 * legal form, strip клон/branch or ЕТ personal-name tokens, or normalize punctuation. Each of
 * those could collapse two distinct фирми into one key — an over-merge, i.e. a false public
 * accusation. When in doubt the key stays MORE specific (a recall miss is safe; an over-merge is not).
 *
 * Degenerate input (empty, whitespace-only, or quote-only) normalizes to `''`. That is NOT a usable
 * match key — every such name would fold to the same empty key and cross-match. Callers MUST treat an
 * empty key as „unmatchable" and skip it (never build a link/person from it); `isMatchableKey` is the
 * guard. Returning `''` here (rather than throwing) keeps the function pure; the skip is the caller's.
 *
 * Pure and deterministic: same input → same output, no I/O, no locale/clock dependence.
 */
export function companyNameKey(raw: string): string {
  return cleanName(raw)
    .toUpperCase()
    .replace(/"/g, ' ') // a quote separates tokens → space, not deletion, so `АБ"ВГ` ≠ `АБВГ`
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when a key can safely be matched. An empty key comes from degenerate input (empty/whitespace/
 *  quote-only) and would cross-match every other degenerate name — an over-merge. Match-sites gate on this. */
export function isMatchableKey(key: string): boolean {
  return key.length > 0;
}
