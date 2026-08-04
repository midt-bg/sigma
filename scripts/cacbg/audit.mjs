// Adversarial accuracy audit of PUBLISHED interest_links. Independent of load.mjs: it rebuilds the
// name-key → ЕИК map from scratch over the live bidders table and re-proves the libel-critical
// invariant (one distinctive key → exactly one eik_valid ЕИК == the published one) for every
// published link. Anything that fails is a hard finding, not a warning. Read-only.
//
// Run: node --import ./scripts/cacbg/register-ts.mjs scripts/cacbg/audit.mjs
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nameDistinctiveness } from './classify.mjs';
import { companyCandidates, declaredEiks } from './extract-companies.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB = process.env.CACBG_DB || path.join(ROOT, 'data/work/backfill.sqlite');
const { companyNameKey } = await import('../../packages/shared/src/company-name-key.ts');

const db = new DatabaseSync(DB, { readOnly: true });

// 1. Rebuild key → {valid ЕИК set, sample names} from ALL bidders — the ground truth the guard rests on.
const byKey = new Map();
for (const b of db.prepare('SELECT name, eik_normalized, eik_valid FROM bidders').all()) {
  const k = companyNameKey(b.name);
  let rec = byKey.get(k);
  if (!rec) byKey.set(k, (rec = { valid: new Set(), names: new Set() }));
  rec.names.add(b.name);
  if (b.eik_valid && b.eik_normalized) rec.valid.add(b.eik_normalized);
}

const published = db
  .prepare(
    `
  SELECT il.id, il.link_key, il.person_id, il.eik, il.entity_key, il.match_method, il.publish_tier,
         il.bidder_id, il.relation, il.contemporaneous, il.contract_value_eur,
         b.name AS bidder_name, b.eik_normalized AS bidder_eik, b.eik_valid AS bidder_eik_valid
  FROM interest_links il JOIN bidders b ON b.id = il.bidder_id
  WHERE il.status = 'published'`,
  )
  .all();

const findings = [];
const flag = (link, axis, detail) =>
  findings.push({ axis, link_key: link.link_key, eik: link.eik, detail });

for (const l of published) {
  const rec = byKey.get(l.entity_key);

  // A. Libel-critical identity. Name-resolved links: the name key must resolve to EXACTLY ONE valid ЕИК,
  //    and it must be l.eik. A_eik links (ADR-0028): identity is the declarant-provided ЕИК, not the name —
  //    a name shared by >1 winner is legitimate because the ЕИК picks exactly one — so instead require that
  //    l.eik is a valid winner BEARING this name key (a stray/mis-attached ЕИК is still caught). The ЕИК+name
  //    double-lock itself is re-proven in the provenance pass below (A_eik_no_provenance).
  if (!rec) flag(l, 'A_key_missing', `entity_key ${l.entity_key} not found in live bidder set`);
  else if (l.publish_tier === 'A_eik') {
    if (!rec.valid.has(l.eik))
      flag(
        l,
        'A_eik_not_winner',
        `A_eik published ${l.eik}, not among key ${l.entity_key}'s valid winners {${[...rec.valid].join(',')}}`,
      );
  } else if (rec.valid.size !== 1)
    flag(
      l,
      'A_multi_eik',
      `key ${l.entity_key} → ${rec.valid.size} valid ЕИК {${[...rec.valid].join(',')}}; names {${[...rec.names].join(' | ')}}`,
    );
  else if (![...rec.valid][0] || [...rec.valid][0] !== l.eik)
    flag(l, 'A_eik_mismatch', `key resolves to ${[...rec.valid][0]} but link published ${l.eik}`);

  // B. Row integrity: the stored bidder must itself be the valid, published ЕИК.
  if (l.bidder_eik !== l.eik)
    flag(l, 'B_bidder_eik', `bidder_id eik ${l.bidder_eik} != link eik ${l.eik}`);
  if (!l.bidder_eik_valid)
    flag(l, 'B_eik_invalid', `published on eik_valid=0 bidder ${l.bidder_name}`);

  // C. Tier honesty: B_distinctive must actually be distinctive by the same classifier that gated it.
  if (l.publish_tier === 'B_distinctive' && nameDistinctiveness(l.entity_key) !== 'distinctive')
    flag(
      l,
      'C_not_distinctive',
      `tier B_distinctive but nameDistinctiveness=${nameDistinctiveness(l.entity_key)} (${l.bidder_name})`,
    );
}

// D. Non-exact matches carry the highest resolution risk — surface each with its raw declared text so the
//    cross-check (winner name present in the prose / declared ЕИК) is human-verifiable, not asserted blind.
const nonExact = published.filter((l) => l.match_method !== 'exact_name_key');
// declared entities belonging to THIS link's person (declarations.person_id == link.person_id)
const rawForPerson = db.prepare(`
  SELECT di.entity_raw FROM declared_interests di
  JOIN declarations d ON d.id = di.declaration_id
  WHERE d.person_id = ?`);

const provenance = [];
for (const l of nonExact) {
  const rows = rawForPerson.all(l.person_id);
  const winnerKey = companyNameKey(l.bidder_name);
  const hit = rows.find((r) => {
    const t = r.entity_raw || '';
    const eikHit = declaredEiks(t).includes(l.eik);
    // Boundary-safe name confirmation (mirrors load.mjs resolveEntity): the winner фирма must appear as a
    // „NAME" ФОРМА candidate. The raw `companyNameKey(t).includes(winnerKey)` leg was removed — it had the
    // same mid-token over-merge risk as the resolver, so the audit gate would rubber-stamp it (ADR-0016).
    const nameHit = companyCandidates(t).some((c) => companyNameKey(c) === winnerKey);
    return (
      (l.match_method === 'declared_eik' && eikHit && nameHit) ||
      (l.match_method === 'extracted_name' && nameHit)
    );
  });
  // A_eik's identity rests on the declarant-provided ЕИК, so the double-lock MUST be independently re-provable:
  // if no declaration by this person carries that ЕИК together with the winner фирма, it is a hard finding
  // (an extracted_name link is name-only — surfaced below for eyeballing, but not hard-gated here).
  if (!hit && l.match_method === 'declared_eik')
    flag(
      l,
      'A_eik_no_provenance',
      `no declaration carries ЕИК ${l.eik} + фирма "${l.bidder_name}"`,
    );
  provenance.push({
    link_key: l.link_key,
    eik: l.eik,
    method: l.match_method,
    winner: l.bidder_name,
    evidence: hit ? hit.entity_raw : null,
  });
}

db.close();

// Report
const byAxis = {};
for (const f of findings) (byAxis[f.axis] ??= []).push(f);
console.log(`# CACBG published-link accuracy audit\n`);
console.log(`published links audited: ${published.length}`);
console.log(`hard findings: ${findings.length}\n`);
for (const [axis, fs] of Object.entries(byAxis)) {
  console.log(`## ${axis} — ${fs.length}`);
  for (const f of fs.slice(0, 20)) console.log(`  - [${f.eik}] ${f.detail}`);
  console.log('');
}
console.log(`## non-exact provenance (${provenance.length}) — verify each cross-check by eye`);
for (const p of provenance) {
  console.log(`  - ${p.method} [${p.eik}] winner="${p.winner}"`);
  console.log(
    `      evidence: ${p.evidence ? JSON.stringify(p.evidence) : 'NONE FOUND (cross-check would now fail!)'}`,
  );
}

if (findings.length) process.exitCode = 1;
