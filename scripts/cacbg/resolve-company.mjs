import {
  companyNameKey,
  companyNameStem,
  isMatchableKey,
} from '../../packages/shared/src/company-name-key.ts';
import { companyCandidates, declaredEiks } from './extract-companies.mjs';

/** With an explicit EIK, spacing around an existing hyphen is presentation, not a name-only alias.
 * Keep every letter, number, hyphen and legal form; never use this key for name-only matching. */
export const eikCompanyNameKey = (name) => companyNameKey(name).replace(/\s*-\s*/g, '-');

/** Index companies by `companyNameStem`; stems under four letters are left out. */
export function stemIndex(companies) {
  const index = new Map();
  for (const { eik, name } of companies) {
    const stem = companyNameStem(name);
    if (stem.length < 4) continue;
    if (!index.has(stem)) index.set(stem, new Set());
    index.get(stem).add(eik);
  }
  return index;
}

/** Does one declared field name the winner under `method`? `names` are the winner's names as a bidder.
 * The audit re-proves every non-exact link with it; the ЕИК itself is checked by the caller. */
export function namesCompany(entity, method, names) {
  const named = companyCandidates(entity);
  if (method === 'declared_eik')
    return named.some((c) => names.some((n) => eikCompanyNameKey(c) === eikCompanyNameKey(n)));
  if (method === 'extracted_name')
    return named.some((c) => names.some((n) => companyNameKey(c) === companyNameKey(n)));
  if (method === 'name_stem') {
    const stem = companyNameStem(named.length ? named[0] : entity);
    return stem.length >= 4 && names.some((n) => companyNameStem(n) === stem);
  }
  return false;
}

/** Resolve one company-bearing field without choosing between contradictory identities.
 * `byStem` adds a last, weaker step (`name_stem`): the фирма without its legal form and punctuation. A
 * stem match names a company only; the register has to show the declarant in it before anything is
 * published. */
export function resolveDeclaredCompany(
  entity,
  { byKey, bidderByEik, nameKey = companyNameKey, byStem },
) {
  const validEiks = (key) =>
    new Set(
      [...(byKey.get(key)?.values() ?? [])].filter((b) => b.eik && b.valid).map((b) => b.eik),
    );
  const key = nameKey(entity);
  if (!isMatchableKey(key)) return null;
  const exact = validEiks(key);
  if (exact.size === 1) return { eik: [...exact][0], method: 'exact_name_key' };
  if (exact.size > 1) return { ambiguous: true };

  const candidates = [...new Set(companyCandidates(entity).map(nameKey))];
  const stated = declaredEiks(entity);
  if (stated.length) {
    // A contradictory/unresolved number must not disappear in a later name-only fallback.
    // Multiple identifiers in one field do not establish which belongs to which company.
    if (stated.length !== 1) return { ambiguous: true };
    const bidder = bidderByEik.get(stated[0]);
    const registered = new Set(
      [bidder?.name, ...(bidder?.names ?? [])]
        .filter(Boolean)
        .map((n) => eikCompanyNameKey(nameKey(n))),
    );
    const named = candidates.map(eikCompanyNameKey);
    if (!named.length || named.some((c) => !isMatchableKey(c) || !registered.has(c)))
      return { ambiguous: true };
    return { eik: stated[0], method: 'declared_eik' };
  }
  // Even an unmatched second company is a second possible subject of this field.
  if (candidates.length > 1) return { ambiguous: true };
  const matches = validEiks(candidates[0]);
  if (matches.size > 1) return { ambiguous: true };
  if (matches.size === 1) return { eik: [...matches][0], method: 'extracted_name' };
  if (!byStem) return null;
  const named = companyCandidates(entity);
  const stems = byStem.get(companyNameStem(named.length ? named[0] : entity));
  if (!stems) return null;
  return stems.size === 1 ? { eik: [...stems][0], method: 'name_stem' } : { ambiguous: true };
}
