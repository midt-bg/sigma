import { declarantNameKey, declarationAttribution } from './source-identity.mjs';
import { resolveDeclaredCompany } from './resolve-company.mjs';
import { companyNameKey } from '../../packages/shared/src/company-name-key.ts';
import { nameDistinctiveness } from './classify.mjs';
import { normalizeSettlement } from '../tr/deed.mjs';

export const IDENTITY_RULES_VERSION = 'registry-identity-1';
const HASH = /^[a-f0-9]{64}$/i;
const SELF_KINDS = new Set(['shares', 'participation', 'sole_trader', 'management']);

/** Public registry identities, read once. Names select evidence; they never become identity keys. */
export function registryIdentityResolver(registry) {
  const byKey = new Map();
  const bidderByEik = new Map();
  const seats = new Map();
  for (const r of registry
    .prepare("SELECT eik,name,seat_settlement FROM registry_deeds WHERE outcome='ok'")
    .all()) {
    const company = { eik: r.eik, name: r.name, valid: true };
    bidderByEik.set(r.eik, company);
    seats.set(r.eik, normalizeSettlement(r.seat_settlement));
    const key = companyNameKey(r.name);
    const companies = byKey.get(key) ?? new Map();
    companies.set(r.eik, company);
    byKey.set(key, companies);
  }
  const namesByCompany = new Map();
  for (const r of registry
    .prepare(
      `SELECT DISTINCT eik,subject_id,subject_name,entry_number FROM registry_roles
    WHERE subject_kind='person' AND role IN ('partner','sole_owner','trader','manager')
      AND entry_number IS NOT NULL AND entry_number<>'' ORDER BY eik,subject_id,entry_number`,
    )
    .all()) {
    if (!HASH.test(r.subject_id)) continue;
    const name = declarantNameKey(r.subject_name);
    if (name.split(' ').length < 3) continue;
    const company = namesByCompany.get(r.eik) ?? new Map();
    const subjects = company.get(name) ?? new Map();
    subjects.set(r.subject_id.toLowerCase(), r.entry_number);
    company.set(name, subjects);
    namesByCompany.set(r.eik, company);
  }
  return (declaration, listedNames) => {
    const attribution = declarationAttribution(declaration.declarant, listedNames);
    const name = declarantNameKey(declaration.declarant);
    const listed = [...new Set(listedNames.map(declarantNameKey).filter(Boolean))];
    const proofs = new Map();
    let aliasesProven = false;
    for (const interest of declaration.interests ?? []) {
      if (interest.holderRelation !== 'self' || !SELF_KINDS.has(interest.kind)) continue;
      const resolved = resolveDeclaredCompany(interest.entity, { byKey, bidderByEik });
      if (!resolved || resolved.ambiguous) continue;
      const company = bidderByEik.get(resolved.eik);
      const seat = normalizeSettlement(interest.seat);
      if (
        resolved.method !== 'declared_eik' &&
        !(seat && seat === seats.get(resolved.eik)) &&
        nameDistinctiveness(companyNameKey(company.name)) !== 'distinctive'
      )
        continue;
      const names = namesByCompany.get(resolved.eik);
      const candidates = names?.get(name);
      if (!candidates?.size) continue;
      for (const [indent, entryNumber] of candidates) {
        proofs.set(`${indent}|${resolved.eik}`, {
          registryIndent: indent,
          eik: resolved.eik,
          entryNumber,
          documentName: declaration.declarant,
          listedNames: [...listedNames].sort(),
          rule: IDENTITY_RULES_VERSION,
        });
      }
      if (
        candidates.size === 1 &&
        listed.length &&
        listed.every((alias) => {
          const ids = names.get(alias);
          return ids?.size === 1 && ids.has([...candidates.keys()][0]);
        })
      )
        aliasesProven = true;
    }
    const evidence = [...proofs.values()].sort(
      (a, b) => a.registryIndent.localeCompare(b.registryIndent) || a.eik.localeCompare(b.eik),
    );
    const unique = new Set(evidence.map((p) => p.registryIndent));
    const acceptedAlias =
      aliasesProven &&
      unique.size === 1 &&
      ['declarant_mismatch', 'ambiguous_listing'].includes(attribution);
    return {
      attribution: acceptedAlias ? 'registry_alias' : attribution,
      evidence: attribution === 'matched' || acceptedAlias ? evidence : [],
    };
  };
}
