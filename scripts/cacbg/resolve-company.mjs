import { companyNameKey, isMatchableKey } from '../../packages/shared/src/company-name-key.ts';
import { companyCandidates, declaredEiks } from './extract-companies.mjs';

/** Resolve one company-bearing field without choosing between contradictory identities. */
export function resolveDeclaredCompany(entity, { byKey, bidderByEik }) {
  const validEiks = (key) =>
    new Set(
      [...(byKey.get(key)?.values() ?? [])].filter((b) => b.eik && b.valid).map((b) => b.eik),
    );
  const key = companyNameKey(entity);
  if (!isMatchableKey(key)) return null;
  const exact = validEiks(key);
  if (exact.size === 1) return { eik: [...exact][0], method: 'exact_name_key' };
  if (exact.size > 1) return { ambiguous: true };

  const candidates = [...new Set(companyCandidates(entity).map(companyNameKey))];
  const stated = declaredEiks(entity);
  if (stated.length) {
    // A contradictory/unresolved number must not disappear in a later name-only fallback.
    // Multiple identifiers in one field do not establish which belongs to which company.
    if (stated.length !== 1) return { ambiguous: true };
    const bidder = bidderByEik.get(stated[0]);
    const winnerKey = companyNameKey(bidder?.name ?? '');
    if (!isMatchableKey(winnerKey) || !candidates.includes(winnerKey)) return { ambiguous: true };
    if (candidates.some((c) => c !== winnerKey)) return { ambiguous: true };
    return { eik: stated[0], method: 'declared_eik' };
  }
  // Even an unmatched second company is a second possible subject of this field.
  if (candidates.length > 1) return { ambiguous: true };
  const matches = validEiks(candidates[0]);
  if (matches.size > 1) return { ambiguous: true };
  return matches.size === 1 ? { eik: [...matches][0], method: 'extracted_name' } : null;
}
