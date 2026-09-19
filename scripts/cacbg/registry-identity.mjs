import { createHash } from 'node:crypto';
import { declarantNameKey, declarationAttribution } from './source-identity.mjs';
import { companyCandidates } from './extract-companies.mjs';
import { resolveDeclaredCompany, stemIndex } from './resolve-company.mjs';
import { companyNameKey, companyNameStem } from '../../packages/shared/src/company-name-key.ts';
import { personNamesAlike } from '../../packages/shared/src/person-identity.ts';

export const IDENTITY_RULES_VERSION = 'registry-identity-4';
const HASH = /^[a-f0-9]{64}$/i;
// Visual Latin/Cyrillic equivalents only, in a Cyrillic-dominant name. This is NOT phonetic transliteration.
export function mixedScriptCompanyKey(raw) {
  const key = companyNameKey(raw);
  const stem = key.replace(/ (?:Е?ООД|Е?АД|ЕТ|СД|КД|КДА)$/, '');
  const latin = stem.match(/[A-Z]/g) ?? [];
  if (!latin.length || (stem.match(/[А-Я]/g)?.length ?? 0) < latin.length) return key;
  const alphabet = {
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
  if (latin.some((c) => !alphabet[c])) return key;
  return key.replace(/[ABCEHKMOPTXY]/g, (c) => alphabet[c]);
}

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

/** A digest of every registry fact the resolver reads, in one fixed order. An interrupted extract may
 * only resume against the same facts: the six-hourly registry run can move them under a long job, and
 * two halves decided under different facts must never be glued together. */
export function identityInputsDigest(registry) {
  const hash = createHash('sha256').update(IDENTITY_RULES_VERSION);
  const table = (name) =>
    registry.prepare(`SELECT 1 FROM sqlite_master WHERE name='${name}'`).get();
  for (const r of registryIdentityRows(registry)) hash.update(JSON.stringify(Object.values(r)));
  if (table('registry_deeds'))
    for (const r of registry
      .prepare("SELECT eik,name,legal_form FROM registry_deeds WHERE outcome='ok' ORDER BY eik")
      .all())
      hash.update(JSON.stringify(Object.values(r)));
  if (table('registry_company_history'))
    for (const r of registry
      .prepare(
        `SELECT h.eik,h.source_hash,h.names_json FROM registry_company_history h
         JOIN registry_identity_snapshots s USING(eik) WHERE h.source_hash=s.source_hash
         ORDER BY h.eik,h.source_hash`,
      )
      .all())
      hash.update(JSON.stringify(Object.values(r)));
  return hash.digest('hex');
}

/** Each company's registered people with a full name: ЕИК → name → identifier → observation. */
function peopleByCompany(registry) {
  const people = new Map();
  for (const r of registryIdentityRows(registry)) {
    if (!HASH.test(r.subject_id)) continue;
    const name = declarantNameKey(r.subject_name);
    if (name.split(' ').length < 3) continue;
    const company = people.get(r.eik) ?? new Map();
    const subjects = company.get(name) ?? new Map();
    subjects.set(r.subject_id.toLowerCase(), r);
    company.set(name, subjects);
    people.set(r.eik, company);
  }
  return people;
}

/** The people a company registers under this name: the exact spelling, else its variants (a surname added,
 * dropped or taken on marriage, one typo). */
function subjectsNamed(company, person) {
  const exact = company?.get(declarantNameKey(person ?? ''));
  if (exact?.size) return exact;
  return new Map(
    [...(company ?? [])]
      .filter(([name]) => personNamesAlike(person ?? '', name))
      .flatMap(([, subjects]) => [...subjects]),
  );
}

/** Resolve declared companies against registry data, including declarations of related-person stakes.
 * The company is its ЕИК: the declared one, or the one the declared name leads to. */
export function registryCompanyResolver(registry, people = peopleByCompany(registry)) {
  const fullName = (name, suffix) =>
    suffix && !companyNameKey(name).endsWith(` ${suffix}`) ? `${name} ${suffix}` : name;
  const byKey = new Map();
  const bidderByEik = new Map();
  const history = new Map();
  const folded = new Map();
  if (registry.prepare("SELECT 1 FROM sqlite_master WHERE name='registry_company_history'").get()) {
    for (const r of registry
      .prepare(
        'SELECT h.* FROM registry_company_history h JOIN registry_identity_snapshots s USING(eik) WHERE h.source_hash=s.source_hash ORDER BY h.eik',
      )
      .all())
      history.set(
        r.eik,
        JSON.parse(r.names_json).map((n) => ({ ...n, sourceHash: r.source_hash })),
      );
  }
  for (const r of registry
    .prepare("SELECT eik,name,legal_form FROM registry_deeds WHERE outcome='ok' ORDER BY eik")
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
    const registeredName = fullName(r.name, suffix);
    const aliases = (history.get(r.eik) ?? []).map((n) => fullName(n.name, n.legalForm));
    const company = { eik: r.eik, name: registeredName, names: aliases, valid: true };
    bidderByEik.set(r.eik, company);
    for (const name of [registeredName, ...aliases]) {
      for (const [index, key] of [
        [byKey, companyNameKey(name)],
        [folded, mixedScriptCompanyKey(name)],
      ]) {
        const companies = index.get(key) ?? new Map();
        companies.set(r.eik, company);
        index.set(key, companies);
      }
    }
  }
  const byStem = stemIndex(
    [...bidderByEik.values()].flatMap((c) =>
      [c.name, ...c.names].map((name) => ({ eik: c.eik, name })),
    ),
  );
  return (interest, authorName) => {
    let resolved = resolveDeclaredCompany(interest.entity, { byKey, bidderByEik });
    let mixed = false;
    let stem = false;
    if (!resolved) {
      resolved = resolveDeclaredCompany(interest.entity, {
        byKey: folded,
        bidderByEik,
        nameKey: mixedScriptCompanyKey,
      });
      mixed = !!resolved && !resolved.ambiguous;
    }
    if (!resolved) {
      resolved = resolveDeclaredCompany(interest.entity, { byKey: new Map(), bidderByEik, byStem });
      stem = !!resolved && !resolved.ambiguous;
    }
    if (!resolved || resolved.ambiguous) return { reason: 'company_not_resolved' };
    const company = bidderByEik.get(resolved.eik);
    const authorIds = subjectsNamed(people.get(resolved.eik), authorName);
    // A visual spelling or a stem alone is not company evidence: require the original declarant's
    // personal registry observation in this same partida. Related-person declarations cannot borrow it.
    if ((mixed || stem) && !(interest.holderRelation === 'self' && authorIds.size === 1))
      return { reason: 'company_evidence_insufficient' };
    const nameKey = mixed ? mixedScriptCompanyKey : stem ? companyNameStem : companyNameKey;
    const keys = new Set([interest.entity, ...companyCandidates(interest.entity)].map(nameKey));
    const currentName = keys.has(nameKey(company.name));
    const historic = (history.get(resolved.eik) ?? []).find((n) =>
      keys.has(nameKey(fullName(n.name, n.legalForm))),
    );
    const companyProof =
      mixed || stem
        ? (historic ?? { name: company.name })
        : !currentName && historic
          ? historic
          : null;
    return {
      ...resolved,
      ...(mixed
        ? { method: 'registry_mixed_script' }
        : stem
          ? { method: 'registry_name_stem' }
          : companyProof
            ? { method: 'registry_name_history' }
            : {}),
      ...(companyProof ? { registryCompany: companyProof } : {}),
      reason: 'personal_name_not_observed',
      authorNameConflict: authorIds.size > 1,
    };
  };
}

/** Public registry identities, read once. Names select evidence; they never become identity keys. */
export function registryIdentityResolver(registry) {
  const namesByCompany = peopleByCompany(registry);
  const resolveCompany = registryCompanyResolver(registry, namesByCompany);
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
      const resolved = resolveCompany(interest, declaration.declarant);
      if (resolved.eik)
        companies.push({
          entity: interest.entity,
          seat: interest.seat ?? '',
          kind: interest.kind,
          holderRelation: interest.holderRelation,
          eik: resolved.eik,
          method: resolved.method,
          ...(resolved.registryCompany ? { registryCompany: resolved.registryCompany } : {}),
        });
      if (interest.holderRelation !== 'self') continue;
      reason = resolved.reason;
      if (!resolved.eik) continue;
      const names = namesByCompany.get(resolved.eik);
      const candidates = subjectsNamed(names, declaration.declarant);
      if (!candidates.size) continue;
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
    // A registry-proven alias outranks a typing slip: when the register establishes the person, the
    // answer is `registry_alias` with its evidence, not the weaker `name_variant` the names alone give.
    const acceptedAlias =
      aliasesProven &&
      unique.size === 1 &&
      ['declarant_mismatch', 'ambiguous_listing', 'name_variant'].includes(attribution);
    const accepted = attribution === 'matched' || attribution === 'name_variant' || acceptedAlias;
    return {
      attribution: acceptedAlias ? 'registry_alias' : attribution,
      companies: accepted ? companies : [],
      reason: evidence.length
        ? unique.size === 1
          ? 'verified_registry'
          : 'ambiguous_registry_identity'
        : reason,
      evidence: accepted ? evidence : [],
    };
  };
}
