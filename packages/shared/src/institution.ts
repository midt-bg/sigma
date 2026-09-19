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
const abbrevKey = (s: unknown): string =>
  String(s ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
const ALIAS_BY_KEY = new Map([...ALIASES].map(([k, v]) => [abbrevKey(k), v]));

/**
 * Canonical institution string for identity keying. Returns the full name for a known abbreviation,
 * the trimmed input otherwise (unknown/ambiguous strings pass through), and '' for empty/nullish.
 */
export function canonicalInstitution(name: unknown): string {
  const trimmed = String(name ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
  if (!trimmed) return '';
  return ALIAS_BY_KEY.get(trimmed.toUpperCase()) ?? trimmed;
}

// Latin capitals indistinguishable from Cyrillic ones in print. A register string that is otherwise
// Cyrillic but carries one of these („НАРОДНО СЪБРАНИE" with a Latin E) names the same institution; left
// alone, the homoglyph silently splits one official into two identities.
const LATIN_LOOKALIKE: Record<string, string> = {
  A: 'А',
  B: 'В',
  C: 'С',
  E: 'Е',
  H: 'Н',
  K: 'К',
  M: 'М',
  O: 'О',
  P: 'Р',
  T: 'Т',
  X: 'Х',
  Y: 'У',
};

/**
 * The institution one declaration belongs to (ADR-0040).
 *
 * The DECLARATION decides. Its `<Work>` field is what the person signed; the register's listing is only
 * how the register arranged the documents, and the two can disagree. They did: the 2022 listing filed the
 * executive director of Национална електрическа компания among the members of the European Parliament,
 * between two actual MEPs, and the document that same row points at says „НАЦИОНАЛНА ЕЛЕКТРИЧЕСКА
 * КОМПАНИЯ ЕАД / ИЗПЪЛНИТЕЛЕН ДИРЕКТОР". Preferring the listing published „Европейски парламент · Член"
 * about a named man who is not an MEP.
 *
 * The listing is the fallback, not the authority — in the folders of inaugural/final and of annual
 * declarations its node is the declaration TYPE (its name is the category's) and carries no institution
 * at all, and some documents leave `<Work>` empty.
 * @param {{institution?: string|null, category?: string|null, work?: string|null}} rec
 */
export function declarationInstitution(rec: {
  institution?: string | null;
  category?: string | null;
  work?: string | null;
}): string {
  const listed = String(rec.institution ?? '').trim();
  const category = String(rec.category ?? '').trim();
  const own = String(rec.work ?? '').trim();
  const isCategory = (s: string): boolean =>
    /^(?:встъпителни и финални декларации|ежегодни декларации|държавни предприятия|общински предприятия|училища|процедури по ЗОП|ДКЦ, МЦ, ЦТХ|детски градини, ясли, детка кухня|социални домове и центрове|политически кабинет|финсово управление на средства от ЕС|членовете на управителните и контролните органи на дъщерни дружества)$/iu.test(
      s,
    );
  if (own && !isCategory(own)) return own;
  return listed && !isCategory(listed) && listed.toLowerCase() !== category.toLowerCase()
    ? listed
    : '';
}

/**
 * The institution as an identity key (ADR-0040): the spellings of one body fold together, so an official
 * keeps one identity across the years and forms of their filings. Only folds that cannot join two different
 * bodies — the same municipality under its council's name, the same assembly under another number, the
 * same body with or without a place qualifier. Anything else passes through: a split is safe, a wrong
 * merge is not.
 */
export function identityInstitution(name: unknown): string {
  let t = institutionMatchKey(name);
  if (/[А-Я]/u.test(t)) t = t.replace(/[ABCEHKMOPTXY]/g, (c) => LATIN_LOOKALIKE[c]!);
  return (
    t
      // „47-мо Народно събрание" — an MP re-elected to the next assembly is the same person.
      .replace(/^\d+\s*-?\s*[А-Я]{0,2}\s+(?=НАРОДНО СЪБРАНИЕ)/u, '')
      .replace(/\s+НА\s+(?:РБ|РЕПУБЛИКА БЪЛГАРИЯ)$/u, '')
      // „…, гр. София" and a leading „гр. " qualify the place, not the body.
      .replace(/,\s*(?:ГР|С)\.\s*[^,]+$/u, '')
      // „Община Карнобат", „ОбС Карнобат", „Общински съвет - Карнобат" and the listing's bare „Карнобат".
      .replace(
        /^(?:ОБЩИНА|ОБЩИНСКИ СЪВЕТ|ОБЩ\.?\s*СЪВЕТ|ОБС)(?=[\s,–—-])\s*(?:[-–—,]\s*)?(?:НА\s+)?(?:ОБЩИНА\s+)?(?=\S)/u,
        '',
      )
      .replace(/^(?:ГР|С)\.\s*/u, '')
      // „Област - Смолян" and „Областна администрация - Смолян" — an oblast stays apart from its town.
      .replace(
        /^(?:ОБЛАСТНА АДМИНИСТРАЦИЯ|ОБЛАСТ)(?=[\s,–—-])\s*(?:[-–—,]\s*)?(?:НА\s+)?(?=\S)/u,
        'ОБЛАСТ ',
      )
      // The declarant's Work may repeat the territorial qualifier after the body name.
      .replace(/^ОБЛАСТ\s+ОБЛАСТ\s+/u, 'ОБЛАСТ ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Exact organisation matching must not reuse identityInstitution's municipality/council folding. */
export function institutionMatchKey(name: unknown): string {
  let s = canonicalInstitution(name).toUpperCase();
  if (/[А-Я]/u.test(s)) s = s.replace(/[ABCEHKMOPTXY]/g, (c) => LATIN_LOOKALIKE[c]!);
  return s
    .replace(/\s+НА\s+(?:РБ|РЕПУБЛИКА БЪЛГАРИЯ)$/u, '')
    .replace(/[„“”"«»]/g, '')
    .replace(/\s*[-–—]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
