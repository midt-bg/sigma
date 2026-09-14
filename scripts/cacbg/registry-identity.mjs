import { declarantNameKey, declarationAttribution } from './source-identity.mjs';
import { resolveDeclaredCompany } from './resolve-company.mjs';
import { companyNameKey } from '../../packages/shared/src/company-name-key.ts';
import { nameDistinctiveness } from './classify.mjs';
import { normalizeSettlement } from '../tr/deed.mjs';

export const IDENTITY_RULES_VERSION = 'registry-identity-2';
const HASH = /^[a-f0-9]{64}$/i;
const SELF_KINDS = new Set(['shares', 'participation', 'sole_trader', 'management']);

/** Identity comes only from original per-entry observations, never compacted role labels. */
export function registryIdentityRows(registry) {
  if (
    !registry
      .prepare("SELECT 1 FROM sqlite_master WHERE name='registry_identity_observations'")
      .get()
  )
    return [];
  return registry
    .prepare(
      `SELECT eik,registry_indent subject_id,name subject_name,entry_number,
      sub_uic,field_ident,holder_index,source_hash FROM registry_identity_observations
      WHERE subject_kind='person' AND registry_indent IS NOT NULL AND upper(indent_type) IN ('EGN','LNCH')
      ORDER BY eik,entry_on,entry_number,sub_uic,field_ident,holder_index`,
    )
    .all();
}

/** Resolve declared companies against registry data, including declarations of related-person stakes. */
export function registryCompanyResolver(registry) {
  const byKey = new Map();
  const bidderByEik = new Map();
  const seats = new Map();
  for (const r of registry
    .prepare("SELECT eik,name,legal_form,seat_settlement FROM registry_deeds WHERE outcome='ok'")
    .all()) {
    const suffix = {
      OOD: 'ООД',
      EOOD: 'ЕООД',
      AD: 'АД',
      EAD: 'ЕАД',
      ET: 'ЕТ',
      SD: 'СД',
      KD: 'КД',
      KDA: 'КДА',
    }[r.legal_form];
    // Registry names and legal forms are separate fields. Preserve the form in the match key.
    const fullName =
      suffix && !companyNameKey(r.name).endsWith(` ${suffix}`) ? `${r.name} ${suffix}` : r.name;
    const company = { eik: r.eik, name: fullName, valid: true };
    bidderByEik.set(r.eik, company);
    seats.set(r.eik, normalizeSettlement(r.seat_settlement));
    const key = companyNameKey(fullName);
    const companies = byKey.get(key) ?? new Map();
    companies.set(r.eik, company);
    byKey.set(key, companies);
  }
  return (interest) => {
    const resolved = resolveDeclaredCompany(interest.entity, { byKey, bidderByEik });
    if (!resolved || resolved.ambiguous) return { reason: 'company_not_resolved' };
    const company = bidderByEik.get(resolved.eik);
    const seat = normalizeSettlement(interest.seat);
    if (
      resolved.method !== 'declared_eik' &&
      !(seat && seat === seats.get(resolved.eik)) &&
      nameDistinctiveness(companyNameKey(company.name)) !== 'distinctive'
    )
      return { reason: 'company_evidence_insufficient' };
    return { ...resolved, reason: 'personal_name_not_observed' };
  };
}

/** Public registry identities, read once. Names select evidence; they never become identity keys. */
export function registryIdentityResolver(registry) {
  const resolveCompany = registryCompanyResolver(registry);
  const namesByCompany = new Map();
  for (const r of registryIdentityRows(registry)) {
    if (!HASH.test(r.subject_id)) continue;
    const name = declarantNameKey(r.subject_name);
    if (name.split(' ').length < 3) continue;
    const company = namesByCompany.get(r.eik) ?? new Map();
    const subjects = company.get(name) ?? new Map();
    subjects.set(r.subject_id.toLowerCase(), r);
    company.set(name, subjects);
    namesByCompany.set(r.eik, company);
  }
  return (declaration, listedNames) => {
    const attribution = declarationAttribution(declaration.declarant, listedNames);
    const name = declarantNameKey(declaration.declarant);
    const listed = [...new Set(listedNames.map(declarantNameKey).filter(Boolean))];
    const proofs = new Map();
    let aliasesProven = false;
    let reason = 'no_declared_personal_participation';
    const companies = [];
    for (const interest of declaration.interests ?? []) {
      if (!['self', 'related'].includes(interest.holderRelation) || !SELF_KINDS.has(interest.kind))
        continue;
      const resolved = resolveCompany(interest);
      if (resolved.eik)
        companies.push({
          entity: interest.entity,
          seat: interest.seat ?? '',
          kind: interest.kind,
          holderRelation: interest.holderRelation,
          eik: resolved.eik,
          method: resolved.method,
        });
      if (interest.holderRelation !== 'self') continue;
      reason = resolved.reason;
      if (!resolved.eik) continue;
      const names = namesByCompany.get(resolved.eik);
      const candidates = names?.get(name);
      if (!candidates?.size) continue;
      for (const [indent, observation] of candidates) {
        proofs.set(`${indent}|${resolved.eik}`, {
          registryIndent: indent,
          eik: resolved.eik,
          entryNumber: observation.entry_number,
          observation: observation.source_hash
            ? {
                subUic: observation.sub_uic,
                fieldIdent: observation.field_ident,
                holderIndex: observation.holder_index,
                sourceHash: observation.source_hash,
              }
            : null,
          registryName: observation.subject_name,
          aliasObservations: listed
            .filter((alias) => alias !== name)
            .flatMap((alias) => {
              const o = names.get(alias)?.get(indent);
              return o
                ? [
                    {
                      name: o.subject_name,
                      eik: o.eik,
                      entryNumber: o.entry_number,
                      subUic: o.sub_uic,
                      fieldIdent: o.field_ident,
                      holderIndex: o.holder_index,
                      sourceHash: o.source_hash,
                    },
                  ]
                : [];
            }),
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
      companies: attribution === 'matched' || acceptedAlias ? companies : [],
      reason: evidence.length
        ? unique.size === 1
          ? 'verified_registry'
          : 'ambiguous_registry_identity'
        : reason,
      evidence: attribution === 'matched' || acceptedAlias ? evidence : [],
    };
  };
}
