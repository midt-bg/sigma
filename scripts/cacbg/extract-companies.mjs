// Pure text extractors for recovering matches from FREE-TEXT declared entities — some officials write
// a sentence ("2 дружествени дяла на „ЕН-ФРЕШ" ООД, прехвърлени…") or append the ЕИК/town instead of a
// clean фирма. These pull the deterministic signals out of that prose. No I/O, no normalizer dependency
// (the caller applies companyNameKey), so they're unit-testable directly.

// Kept in sync with classify.mjs's FORM — cooperatives/foundations/associations are real bidders too.
const FORM = '(?:КООПЕРАЦИЯ|ФОНДАЦИЯ|СДРУЖЕНИЕ|ЕООД|ЕАД|ООД|АД|ЕТ|ДЗЗД|КД|СД|АДСИЦ)';

/**
 * Candidate „NAME" ФОРМА / NAME ФОРМА company substrings inside a free-text declaration entry.
 * Returns the matched "…name + legal form" slices (caller normalizes + resolves each). Order preserved.
 */
export function companyCandidates(text) {
  const out = [];
  // name (optionally quoted) + a required separator (space or closing quote) + a legal form not glued
  // to a longer word. The name quantifier is GREEDY: a form-token WORD embedded mid-name (e.g.
  // „БЪЛГАРСКА АД ГРУП" ООД) must NOT truncate the candidate at the first „АД" — the longest span wins so
  // the trailing real form matches and the full name is captured. A truncated key („БЪЛГАРСКА АД") could
  // exact-match an unrelated short bidder = a fabricated conflict (ADR-0016). Both „…" and «…» quote styles
  // are handled. `\b` is unreliable here — ASCII-only under the /u flag, so Cyrillic breaks it.
  const re = new RegExp(
    '[„"“«»]?\\s*([^„"“«»,;]{2,60})[\\s”"«»]+(?:' + FORM + ')(?![А-Яа-яA-Za-z])',
    'gu',
  );
  for (const m of String(text).matchAll(re)) {
    const s = m[0].replace(/^[\s,;]+/, '').trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * ЕИК/БУЛСТАТ numbers an official wrote into the text. A bare 9/13-digit run qualifies; we DON'T treat
 * a 10-digit run as an ЕИК (that length is an ЕГН/date shape). Returns distinct digit strings; the caller
 * confirms each against the real winner ЕИК set (a random number won't coincide with a winner's ЕИК).
 */
export function declaredEiks(text) {
  const out = new Set();
  // 9 or 13 digits, not part of a longer digit run
  for (const m of String(text).matchAll(/(?<!\d)(\d{9}|\d{13})(?!\d)/g)) out.add(m[1]);
  return [...out];
}
