import { cleanName } from './format';
import { editDistance } from './person-identity';

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

/** The register's legal-form codes, spelled the way the фирма carries them. An unknown code adds nothing. */
export const REGISTRY_LEGAL_FORM: Record<string, string> = {
  ET: 'ЕТ',
  OOD: 'ООД',
  EOOD: 'ЕООД',
  SD: 'СД',
  KD: 'КД',
  KDA: 'КДА',
  AD: 'АД',
  EAD: 'ЕАД',
  ADSITS: 'АДСИЦ',
  K: 'кооперация',
  ASSOC: 'сдружение',
  FOUND: 'фондация',
  KCHT: 'КЧТ',
  ED: 'ЕД',
};

/** The register stores the фирма without its legal form and the form as a code; the reader expects both. */
export function registryCompanyName(name: string, legalForm?: string | null): string {
  const form = REGISTRY_LEGAL_FORM[legalForm?.trim().toUpperCase() ?? ''];
  if (!form || companyNameKey(name).endsWith(` ${form.toUpperCase()}`)) return name;
  return form === 'ЕТ' ? `ЕТ ${name}` : `${name} ${form}`;
}

const FORM_TOKEN =
  /(?:^|\s)(?:ЕООД|ООД|ЕАД|АД|ЕТ|СД|КД|КДА|АДСИЦ|ДЗЗД|КООПЕРАЦИЯ|СДРУЖЕНИЕ|ФОНДАЦИЯ)(?=\s|$)/g;
const LOOKALIKE: Record<string, string> = {
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
 * What is left of a фирма once the legal form, punctuation and Latin look-alikes typed into a Cyrillic
 * name are gone. A comparison aid for „is this the company the document names?" — never a match key
 * that creates a link, because it folds exactly what `companyNameKey` keeps apart.
 */
export function companyNameStem(raw: string): string {
  let s = companyNameKey(raw).replace(/[.,'`´’\-–—]/g, ' ');
  // Only a name whose every Latin letter has a Cyrillic twin can be a Cyrillic name typed on the wrong
  // keyboard; a real Latin name keeps its letters.
  if (s.match(/[A-Z]/g)?.every((c) => LOOKALIKE[c])) s = s.replace(/[A-Z]/g, (c) => LOOKALIKE[c]!);
  return s.replace(FORM_TOKEN, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Two spellings of one фирма: the same stem, or stems one typo apart per dozen characters. Short names
 * get no tolerance — one letter is the whole difference between АЛФА and АЛМА.
 */
export function companyNamesAlike(a: string, b: string): boolean {
  const x = companyNameStem(a);
  const y = companyNameStem(b);
  if (!x || !y) return false;
  return x === y || editDistance(x, y) <= Math.floor((Math.max(x.length, y.length) + 4) / 12);
}

const GLUED_FORM = /(?<=[А-Я]{3})(?:ЕООД|ООД|ЕАД)$/;

/** A declared entry's stem without what declarants add around a фирма: a note in brackets and a legal
 *  form typed onto the last word („…АРТЕООД"). */
function declaredNameStem(raw: string): string {
  return companyNameStem(raw.replace(/\(.*?\)/g, ' '))
    .split(' ')
    .map((w) => w.replace(GLUED_FORM, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether a declared entry may be the company — the test behind „СИГМА не откри дружеството в
 * декларациите". It errs the other way from `companyNamesAlike`: besides a typo, one name contained
 * whole in the other („Х" in „Медицински център Х", „Х" in „Х 97") counts, because the note may only
 * stand where nothing in the filings resembles the company. A missed note costs a signal; a wrong one
 * tells a named official he left out a company he declared.
 */
export function declaredNameMatches(declared: string, company: string): boolean {
  const x = declaredNameStem(declared);
  const y = declaredNameStem(company);
  if (!x || !y) return false;
  if (x === y || companyNamesAlike(x, y)) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && ` ${long} `.includes(` ${short} `);
}

/** The ЕИК written into a declared entry, not as a part of a longer number. */
export function declaredTextHasEik(declared: string, eik: string): boolean {
  if (!/^\d+$/.test(eik)) return false;
  return new RegExp(`(?<!\\d)${eik}(?!\\d)`).test(declared.replace(/\s+/g, ''));
}

/** What a person's filings for one period say: the ЕИК the resolver tied to them and every declared
 *  entry's text. */
export interface DeclaredFilings {
  eiks: readonly string[];
  named: readonly string[];
}

/** A company by its ЕИК and every name it has carried. */
export interface DeclaredCompany {
  eik: string;
  names: readonly (string | null | undefined)[];
}

/** The filings name the company: by a resolved ЕИК, by the ЕИК written in an entry, or by one of its
 *  names under any spelling `declaredNameMatches` accepts. */
export function filingsNameCompany(filings: DeclaredFilings, company: DeclaredCompany): boolean {
  if (filings.eiks.includes(company.eik)) return true;
  const names = company.names.filter((n): n is string => !!n?.trim());
  return filings.named.some(
    (text) =>
      declaredTextHasEik(text, company.eik) ||
      names.some((name) => declaredNameMatches(text, name)),
  );
}
