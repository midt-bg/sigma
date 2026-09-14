// Resolve directly declared companies against an official company-name catalog.
// This broadens registry coverage, never procurement eligibility or personal identity by itself.
import fs from 'node:fs';
import { assertOverrideDirSafe } from './guard.mjs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { companyNameKey } from '../../packages/shared/src/company-name-key.ts';
import { declaredEiks } from './extract-companies.mjs';
import { resolveDeclaredCompany } from './resolve-company.mjs';
import { declarationInstitution, identityInstitution } from './institutions.mjs';
const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
for (const flag of ['--catalog', '--db', '--staging'])
  if (!process.argv.includes(flag)) throw new Error(`${flag} required`);
const catalog = new DatabaseSync(arg('--catalog'), { readOnly: true });
const db = new DatabaseSync(arg('--db'), { readOnly: true });
const staging = arg('--staging');
assertOverrideDirSafe(staging, '--staging');
const byKey = new Map(),
  bidderByEik = new Map();
const forms = {
  OOD: 'ООД',
  EOOD: 'ЕООД',
  AD: 'АД',
  EAD: 'ЕАД',
  ET: 'ЕТ',
  SD: 'СД',
  KD: 'КД',
  KDA: 'КДА',
};
for (const c of catalog.prepare('SELECT eik,name,legal_form FROM companies').iterate()) {
  const form = forms[c.legal_form];
  const name = form && !companyNameKey(c.name).endsWith(' ' + form) ? `${c.name} ${form}` : c.name;
  const key = companyNameKey(name),
    row = { eik: c.eik, name, valid: true };
  if (!byKey.has(key)) byKey.set(key, new Map());
  byKey.get(key).set(c.eik, row);
  bidderByEik.set(c.eik, row);
}
const visible = new Set(
  db
    .prepare("SELECT DISTINCT person_id FROM interest_links WHERE status='published'")
    .all()
    .map((r) => r.person_id),
);
const visibleDocuments = new Set(
  db
    .prepare(
      `SELECT folder_year,xml_file FROM declarations
  WHERE person_id IN (SELECT person_id FROM interest_links WHERE status='published')`,
    )
    .all()
    .map((d) => `${d.folder_year}:${d.xml_file}`),
);
const read = (file) =>
  fs.readFileSync(path.join(staging, file), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const requests = new Map(
  (fs.existsSync(path.join(staging, 'registry-requests.jsonl'))
    ? read('registry-requests.jsonl')
    : []
  ).map((r) => [`${r.eik}|${r.declarationId}`, r]),
);
const urgent = new Set();
let unresolved = 0;
for (const h of read('holdings.jsonl')) {
  const pid = `person:${companyNameKey(h.person)}|${companyNameKey(identityInstitution(declarationInstitution(h)))}`;
  const resolved = resolveDeclaredCompany(h.entity, { byKey, bidderByEik });
  // Explicit EIK requests are also allowed when the catalog predates a registration; the response is checked later.
  const eiks =
    resolved && !resolved.ambiguous
      ? [resolved.eik]
      : declaredEiks(h.entity).filter((e) => /^\d{9}$/.test(e));
  if (!eiks.length) unresolved++;
  for (const eik of eiks) {
    const declarationId = `decl:${h.folder}:${h.xmlFile}`;
    requests.set(`${eik}|${declarationId}`, { eik, declarationId, declaredName: h.entity });
    if (visible.has(pid) || visibleDocuments.has(`${h.folder}:${h.xmlFile}`)) urgent.add(eik);
  }
}
fs.writeFileSync(
  path.join(staging, 'registry-requests.jsonl'),
  [...requests.values()].map(JSON.stringify).join('\n') + '\n',
);
fs.writeFileSync(path.join(staging, 'identity-eiks.txt'), [...urgent].sort().join('\n') + '\n');
console.log(
  JSON.stringify({
    requests: requests.size,
    companies: new Set([...requests.values()].map((r) => r.eik)).size,
    profileCompanies: urgent.size,
    unresolved,
  }),
);
db.close();
catalog.close();
