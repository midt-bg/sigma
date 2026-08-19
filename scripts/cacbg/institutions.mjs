// Institution canonicalization for the person grain (name, institution) — N10, review #226.
// An official who declares „МВР" one year and „Министерство на вътрешните работи" the next must resolve to
// ONE identity, not two person-pages (a presentational split). This folds a CONSERVATIVE, hand-verified set
// of unambiguous, stable central-government abbreviations to their full names.
//
// Deliberately conservative: an abbreviation is included ONLY if it maps to exactly one institution with no
// historical collision. Ambiguous ones are OMITTED (e.g. „МТ" — Министерство на транспорта vs туризма;
// „МИ/МИЕ/МЗХ/МЕ" — repeatedly renamed/merged ministries), because the failure modes are asymmetric: an
// unknown abbreviation falling through unchanged only SPLITS one person into two pages (safe, visible), while
// a WRONG fold MERGES two distinct institutions' officials into one identity (false attribution — libel).
// When in doubt, leave it out.

// abbreviation (normalized) → canonical full name
const ALIASES = new Map([
  ['МВР', 'Министерство на вътрешните работи'],
  ['МО', 'Министерство на отбраната'],
  ['МВнР', 'Министерство на външните работи'],
  ['МФ', 'Министерство на финансите'],
  ['МП', 'Министерство на правосъдието'],
  ['МОН', 'Министерство на образованието и науката'],
  ['МЗ', 'Министерство на здравеопазването'],
  ['МТСП', 'Министерство на труда и социалната политика'],
  ['МРРБ', 'Министерство на регионалното развитие и благоустройството'],
  ['МОСВ', 'Министерство на околната среда и водите'],
  ['МК', 'Министерство на културата'],
  ['ММС', 'Министерство на младежта и спорта'],
  ['МЕУ', 'Министерство на електронното управление'],
  ['МЕ', 'Министерство на енергетиката'],
]);

// Normalize an abbreviation for lookup: NFC, uppercase, collapse whitespace. The full-name VALUES are stored
// as-is; the KEYS are matched case-insensitively (an abbreviation carries no meaningful case).
const abbrevKey = (s) =>
  String(s ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
const ALIAS_BY_KEY = new Map([...ALIASES].map(([k, v]) => [abbrevKey(k), v]));

/**
 * Canonical institution string for identity keying. Returns the full name for a known abbreviation,
 * the trimmed input otherwise (unknown/ambiguous strings pass through), and '' for empty/nullish.
 * @param {string|null|undefined} name
 * @returns {string}
 */
export function canonicalInstitution(name) {
  const trimmed = String(name ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
  if (!trimmed) return '';
  return ALIAS_BY_KEY.get(trimmed.toUpperCase()) ?? trimmed;
}
