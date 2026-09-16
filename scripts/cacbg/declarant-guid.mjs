import { createHash } from 'node:crypto';
import { declarantNameKey } from './source-identity.mjs';

export const DECLARANT_GUID_RULE = 'declarant-guid-1';
const hash = (value) => createHash('sha256').update(value).digest('hex');
// The register names a document `<declarant GUID><document number>.xml`; one declarant keeps the GUID
// across years and institutions. Folders that publish `<GUID>.xml` (a GUID per document) never match.
const GUID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\d+\.xml$/i;

export const declarantGuid = (xmlFile) =>
  GUID_FILE.exec(String(xmlFile ?? ''))?.[1].toUpperCase() ?? null;

// Given and patronymic name; a family name may change between documents of one declarant.
const stem = (name) => name.split(' ').slice(0, 2).join(' ');

/** Same-declarant evidence from the register's own document naming. Names must agree: a GUID under
 * which several unrelated names appear links only documents whose names are identical. */
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
    const oneDeclarant = new Set(docs.map((d) => stem(d.name))).size === 1;
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
