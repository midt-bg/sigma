import { createHash } from 'node:crypto';
import { declarantNameKey } from './source-identity.mjs';
import { institutionMatchKey } from './institutions.mjs';

export const CONTINUITY_RULE = 'declaration-continuity-1';
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
    const year = Number(f.year);
    if (name.split(' ').length < 3 || !Number.isInteger(year) || year < 1990 || year > 2100)
      continue;
    const work = text(f.work),
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
    if (['Entry', 'Vacate'].includes(f.declarationType) && /\d/.test(act) && /\d/.test(date))
      add('appointment_act', [name, work, role, year, f.declarationType, act, date], doc);
    add('employment_years', [name, work, role], doc);
    for (const p of [...(f.companyEvidence ?? [])].sort((a, b) => key(a).localeCompare(key(b)))) {
      if (
        !['self', 'related'].includes(p.holderRelation) ||
        !['shares', 'participation', 'sole_trader', 'management'].includes(p.kind)
      )
        continue;
      const current = resolveCompany(p);
      if (!current.eik || current.eik !== p.eik || current.method !== p.method)
        throw new Error(`Company continuity proof no longer matches its source: ${doc.id}`);
      const companyDoc = { ...doc, company: p };
      add('company_and_work', [name, p.eik, work], companyDoc);
      add('company_and_role', [name, p.eik, role], companyDoc);
    }
  }
  const edges = new Map();
  // A sorted chain has the same connected components as all pairs, with linear edge count.
  // The one-year limit deliberately leaves gaps unbridged without stronger source evidence.
  for (const [, { basis, values, docs }] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...docs.values()].sort((a, b) => a.year - b.year || a.id.localeCompare(b.id));
    for (let i = 1; i < sorted.length; i++) {
      const pair = [sorted[i - 1], sorted[i]];
      if (pair[1].year - pair[0].year > 1) continue;
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
