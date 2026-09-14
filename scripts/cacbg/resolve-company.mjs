import { companyNameKey, isMatchableKey } from '../../packages/shared/src/company-name-key.ts';
import { companyCandidates, declaredEiks } from './extract-companies.mjs';

/** With an explicit EIK, spacing around an existing hyphen is presentation, not a name-only alias.
 * Keep every letter, number, hyphen and legal form; never use this key for name-only matching. */
export const eikCompanyNameKey = (name) => companyNameKey(name).replace(/\s*-\s*/g, '-');

/** Resolve one company-bearing field without choosing between contradictory identities. */
export function resolveDeclaredCompany(entity, { byKey, bidderByEik, nameKey = companyNameKey }) {
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
  return matches.size === 1 ? { eik: [...matches][0], method: 'extracted_name' } : null;
}
