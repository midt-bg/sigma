// ЕИК validity — the Node twin of the rule that already lives in SQL.
//
// `eik_valid` in scripts/normalize-raw.sql decides which bidders get an ЕИК-keyed identity at all, so
// it defines the ЕИК space the whole matcher works in. Until now that rule was callable ONLY from
// SQL, which is why the registry leg needs this: the crawler must decide, in Node, whether a code is
// worth a lookup. The two implementations are pinned against each other by a test that lifts the CASE
// expression straight out of the .sql file and runs both over the same values (eik.test.mjs) — a copy
// of the rule would drift from the thing it is copying.
//
// The rule (ЗТРРЮЛНЦ / БУЛСТАТ):
//   9-digit  — weight digits 1..8 by 1..8; control = sum % 11. If that is 10, re-weight by 3..10;
//              a second 10 becomes 0. Digit 9 must equal the control.
//   13-digit — the leading 9 must themselves be a valid 9-digit ЕИК, then weight digits 9..12 by
//              2,7,3,5 (fallback 4,9,5,7; a second 10 becomes 0). Digit 13 must equal that control.
//
// Everything here is string-in, string-out. An ЕИК is an identifier, not a number: public bodies carry
// codes of exactly the `000…` shape, and a numeric round-trip drops the leading zeros and silently
// turns one company's identifier into another's.

/** Weighted control digit over `digits`, with the standard second-pass fallback. @returns {number} */
function control(digits, primary, fallback) {
  const sum = (ws) => ws.reduce((acc, w, i) => acc + w * digits[i], 0) % 11;
  const first = sum(primary);
  if (first < 10) return first;
  const second = sum(fallback);
  return second < 10 ? second : 0;
}

/**
 * Is this a structurally valid ЕИК (9 or 13 digits, correct control digit)?
 * Service codes (`000000000`, `0000000000000`) are rejected outright, matching the SQL: they pass the
 * arithmetic but are placeholders, and letting them through collapsed unrelated foreign suppliers onto
 * one node (#195).
 * @param {unknown} eik @returns {boolean}
 */
export function eikChecksumValid(eik) {
  const s = String(eik ?? '');
  if (s === '000000000' || s === '0000000000000') return false;
  if (!/^\d+$/.test(s)) return false;
  if (s.length !== 9 && s.length !== 13) return false;

  const d = [...s].map(Number);
  const c9 = control(d.slice(0, 8), [1, 2, 3, 4, 5, 6, 7, 8], [3, 4, 5, 6, 7, 8, 9, 10]);
  if (c9 !== d[8]) return false;
  if (s.length === 9) return true;

  const c13 = control(d.slice(8, 12), [2, 7, 3, 5], [4, 9, 5, 7]);
  return c13 === d[12];
}

/**
 * Normalise a raw ЕИК string to digits only, or null when it is not one.
 * Mirrors the SQL's `eik_clean`: strips a leading „ЕИК " label and surrounding whitespace, and does
 * NOT otherwise repair the value. Validity is a separate question — `eikChecksumValid`.
 * @param {unknown} raw @returns {string|null}
 */
export function normalizeEik(raw) {
  const s = String(raw ?? '').trim();
  const stripped = (s.startsWith('ЕИК ') ? s.slice(4) : s).trim();
  return /^\d{9}$|^\d{13}$/.test(stripped) ? stripped : null;
}
