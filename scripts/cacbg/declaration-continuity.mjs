import { createHash } from 'node:crypto';
import { declarantNameKey } from './source-identity.mjs';
import { institutionMatchKey } from './institutions.mjs';

export const CONTINUITY_RULE = 'declaration-continuity-3';
export const COMPANY_AUTHOR_BASIS = 'company_author';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const key = (...values) => JSON.stringify(values);
const text = (value) => institutionMatchKey(value ?? '');

/** Candidate author continuity, not company ownership or proof of a term of office.
 * Only original declaration fields participate; list labels and publication dates do not. */
export function declarationContinuity(filings, resolveCompany) {
  const groups = new Map();
  const add = (basis, values, doc) => {
    if (values.some((v) => !v)) return;
    const id = key(basis, ...values);
    if (!groups.has(id)) groups.set(id, { basis, values, docs: new Map() });
    groups.get(id).docs.set(doc.id, doc);
  };
  for (const f of filings) {
    const name = declarantNameKey(f.person);
    if (name.split(' ').length < 3) continue;
    const parsedYear = Number(f.year);
    const year =
      Number.isInteger(parsedYear) && parsedYear >= 1990 && parsedYear <= 2100 ? parsedYear : null;
    // The EMPLOYER grain, not the exact organisation: a declarant writes „Община Две Могили" one year
    // and the listing's bare „Две Могили" the next, and read with the exact-match key those are two
    // employers — so one person's filings stayed in separate records over a spelling. The same holds
    // for an administration named after its own body. The COUNCIL is deliberately NOT folded into the
    // municipality (see the test): it is a different body, and this fold must not join two of them.
    const employer = (value) =>
      text(value)
        .replace(
          /^ОБЩИНСКА АДМИНИСТРАЦИЯ\s+(?:(?:НА\s+)?ОБЩИНА\s+)?(?:(?:ГРАД|ГР\.)\s+)?(?=\S)/u,
          'ОБЩИНА ',
        )
        .replace(/^ОБЛАСТНА АДМИНИСТРАЦИЯ\s+(?:(?:НА\s+)?ОБЛАСТ\s+)?(?=\S)/u, 'ОБЛАСТ ')
        .replace(/^ОБЩИНА\s+(?:(?:ГРАД|ГР\.)\s+)?(?=\S)/u, '')
        .replace(/^(?:ГР|С)\.\s*/u, '')
        .trim();
    const work = employer(f.work),
      role = text(f.declaredPosition);
    const doc = {
      id: `cacbg:${f.folder}:${f.xmlFile}`,
      hash: f.sourceHash,
      year,
      work: f.work ?? '',
      role: f.declaredPosition ?? '',
    };
    // Act numbers are local to an institution and year. Partial dates stay partial.
    const act = String(f.appointmentNumber ?? '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '');
    const date = String(f.appointmentDate ?? '')
      .trim()
      .replace(/[./\s]+$/g, '');
    if (
      year &&
      ['Entry', 'Vacate'].includes(f.declarationType) &&
      /\d/.test(act) &&
      /\d/.test(date)
    )
      add('appointment_act', [name, work, role, year, f.declarationType, act, date], doc);
    if (year) add('employment_years', [name, work, role], doc);
    for (const p of [...(f.companyEvidence ?? [])].sort((a, b) => key(a).localeCompare(key(b)))) {
      if (
        !['self', 'related'].includes(p.holderRelation) ||
        !['shares', 'participation', 'sole_trader', 'management'].includes(p.kind)
      )
        continue;
      const current = resolveCompany(p, f.person);
      if (
        !current.eik ||
        current.eik !== p.eik ||
        current.method !== p.method ||
        JSON.stringify(current.registryCompany ?? null) !==
          JSON.stringify(p.registryCompany ?? null)
      )
        throw new Error(`Company continuity proof no longer matches its source: ${doc.id}`);
      if (current.authorNameConflict) continue;
      const companyDoc = { ...doc, company: p };
      // A repeated full author name and verified company identify an author across offices.
      // Neither a missing report year nor a related person's stake creates a personal TR role.
      add(COMPANY_AUTHOR_BASIS, [name, p.eik], companyDoc);
    }
  }
  const edges = new Map();
  // A sorted chain has the same connected components as all pairs, with linear edge count.
  // Employment alone cannot bridge gaps. A verified shared company supplies stronger evidence.
  for (const [, { basis, values, docs }] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...docs.values()].sort((a, b) => a.year - b.year || a.id.localeCompare(b.id));
    for (let i = 1; i < sorted.length; i++) {
      const pair = [sorted[i - 1], sorted[i]];
      if (basis !== COMPANY_AUTHOR_BASIS && pair[1].year - pair[0].year > 1) continue;
      pair.sort((a, b) => a.id.localeCompare(b.id));
      const id = key(...pair.map((d) => d.id));
      if (edges.has(id)) continue;
      const facts = JSON.stringify({ basis, context: values, documents: pair });
      edges.set(id, {
        id: hash(`${CONTINUITY_RULE}|${facts}`),
        left_source: pair[0].id,
        right_source: pair[1].id,
        left_hash: pair[0].hash,
        right_hash: pair[1].hash,
        relation: 'same',
        decision: 'accepted',
        origin: 'automatic',
        rule_version: CONTINUITY_RULE,
        facts,
      });
    }
  }
  return [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));
}
