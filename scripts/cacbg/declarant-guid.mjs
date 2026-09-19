import { createHash } from 'node:crypto';
import { declarantNameKey } from './source-identity.mjs';
import { oneSlipApart } from '../../packages/shared/src/person-identity.ts';

export const DECLARANT_GUID_RULE = 'declarant-guid-2';
const hash = (value) => createHash('sha256').update(value).digest('hex');
// The register names a document `<declarant GUID><document number>.xml`; one declarant keeps the GUID
// across years and institutions. Folders that publish `<GUID>.xml` (a GUID per document) never match.
const GUID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\d+\.xml$/i;

export const declarantGuid = (xmlFile) =>
  GUID_FILE.exec(String(xmlFile ?? ''))?.[1].toUpperCase() ?? null;

// Given and patronymic name; a family name may change between documents of one declarant.
const stem = (name) => name.split(' ').slice(0, 2).join(' ');

/** Same-declarant evidence from the register's own document naming. The GUID is the register's OWN
 * identifier for a declarant, so documents sharing one are the same person unless the register has
 * reused the GUID for somebody else; the name is the guard against exactly that reuse.
 *
 * The guard tolerates one typed slip. Demanding the two names be identical split a single declarant in
 * two over one letter — „СТОЯН ВЕЛИКОВ ПРИМЕРОВ" and „СТОЯН ВЕЛИНОВ ПРИМЕРОВ", the same GUID, the same
 * council, the same two years, arrived as two profiles, and only one of them carried his registry roles.
 * Anything beyond one slip still splits: unrelated names under one GUID link only documents whose names
 * are identical. */
export function declarantGuidEvidence(filings) {
  const byGuid = new Map();
  for (const f of filings) {
    const guid = declarantGuid(f.xmlFile);
    const name = declarantNameKey(f.person);
    if (!guid || !name) continue;
    if (!byGuid.has(guid)) byGuid.set(guid, []);
    byGuid.get(guid).push({ id: `cacbg:${f.folder}:${f.xmlFile}`, hash: f.sourceHash, name });
  }
  const edges = [];
  for (const [guid, docs] of [...byGuid].sort(([a], [b]) => a.localeCompare(b))) {
    const chains = new Map();
    const stems = [...new Set(docs.map((d) => stem(d.name)))].sort();
    // Pairwise, so the answer does not depend on which document the folder happened to list first.
    const oneDeclarant = stems.every((a) => stems.every((b) => a === b || oneSlipApart(a, b)));
    for (const d of docs) {
      const key = oneDeclarant ? '' : d.name;
      if (!chains.has(key)) chains.set(key, []);
      chains.get(key).push(d);
    }
    for (const chain of chains.values()) {
      const sorted = chain.sort((a, b) => a.id.localeCompare(b.id));
      for (let i = 1; i < sorted.length; i++) {
        const pair = [sorted[i - 1], sorted[i]];
        const facts = JSON.stringify({
          guid,
          documents: pair.map((d) => ({ id: d.id, name: d.name })),
        });
        edges.push({
          id: hash(`${DECLARANT_GUID_RULE}|${facts}`),
          left_source: pair[0].id,
          right_source: pair[1].id,
          left_hash: pair[0].hash,
          right_hash: pair[1].hash,
          relation: 'same',
          decision: 'accepted',
          origin: 'automatic',
          rule_version: DECLARANT_GUID_RULE,
          facts,
        });
      }
    }
  }
  return edges.sort((a, b) => a.id.localeCompare(b.id));
}
