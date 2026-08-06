// Adversarial accuracy audit of PUBLISHED interest_links. Independent of load.mjs: it rebuilds the
// name-key → ЕИК map from scratch over the live bidders table and re-proves the libel-critical
// invariant (one distinctive key → exactly one eik_valid ЕИК == the published one) for every
// published link. Anything that fails is a hard finding, not a warning. Read-only.
//
// Run: node --import ./scripts/cacbg/register-ts.mjs scripts/cacbg/audit.mjs
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { companyCandidates, declaredEiks } from './extract-companies.mjs';
import { RULES_VERSION } from '../tr/evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB = process.env.CACBG_DB || path.join(ROOT, 'data/work/backfill.sqlite');
const STAGING = process.env.CACBG_STAGING || path.join(ROOT, 'scratch/cacbg/staging');
const SNAPSHOT = path.join(STAGING, 'published-snapshot.json');
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
         b.name AS bidder_name, b.eik_normalized AS bidder_eik, b.eik_valid AS bidder_eik_valid,
         -- LEFT JOIN, deliberately: a published link with NO seal is the finding, so it must reach the
         -- loop rather than be filtered out of it.
         e.evidence_kind, e.registry_role, e.matched_fact
  FROM interest_links il JOIN bidders b ON b.id = il.bidder_id
  LEFT JOIN interest_link_evidence e ON e.link_key = il.link_key
  WHERE il.status = 'published'`,
  )
  .all();

// The only two evidence rungs that publish (ADR-0033 decision 1). Everything else withholds.
const PUBLISHING_EVIDENCE = new Set(['document', 'confirmed']);
// The closed vocabulary for a sealed matched_fact. Anything else is a potential name leak.
const MATCHED_FACT = /^(?:seat:[\p{Lu} -]+|role:(?:owner|manager):CR_F_\d+[a-z]?_L|eik)$/u;

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
  else if (l.match_method === 'declared_eik') {
    // Identity here is the declarant-provided ЕИК, not the name (ADR-0028), so a name shared by more
    // than one winner is legitimate — the ЕИК picks exactly one. Require instead that l.eik is a valid
    // winner BEARING this name key, which still catches a stray or mis-attached ЕИК. The ЕИК+name
    // double-lock is re-proven independently in the provenance pass below.
    if (!rec.valid.has(l.eik))
      flag(
        l,
        'A_eik_not_winner',
        `declared_eik published ${l.eik}, not among key ${l.entity_key}'s valid winners {${[...rec.valid].join(',')}}`,
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

  // C. Evidence honesty (#279, ADR-0033). The tier IS the evidence kind now, so the axis that used to
  //     re-derive name distinctiveness re-derives the publishing rule instead: a published link must
  //     carry a seal, and that seal must be one of the two rungs that publish. `nameDistinctiveness`
  //     no longer gates publication at all — it survives only as a withholding filter inside the
  //     loader — so re-checking it here would assert a rule that is no longer in force.
  if (!l.evidence_kind)
    flag(l, 'C_no_evidence', `published with no Trade Register evidence seal (${l.bidder_name})`);
  else if (!PUBLISHING_EVIDENCE.has(l.evidence_kind))
    flag(
      l,
      'C_withholding_evidence',
      `published on evidence_kind='${l.evidence_kind}', which withholds (${l.bidder_name})`,
    );
  else if (l.evidence_kind !== l.publish_tier)
    flag(
      l,
      'C_tier_evidence_mismatch',
      `publish_tier='${l.publish_tier}' but sealed evidence_kind='${l.evidence_kind}'`,
    );

  // C2. The PII rail, audited rather than assumed: matched_fact is a CLOSED vocabulary and can never
  //     carry a name. The registry deed's names are read only to produce a boolean and must never reach
  //     a served column (#279 §9, ADR-0033 decision 5). A schema cannot enforce this; this does.
  if (l.matched_fact != null && !MATCHED_FACT.test(l.matched_fact))
    flag(
      l,
      'C_matched_fact_shape',
      `matched_fact='${l.matched_fact}' is outside the closed vocabulary — a name may have leaked`,
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

// D. Monotonicity — ADR-0033 decision 6, the correction of #279 §8.
//
// §8 asked for a seal kept „forever" and strictly-additive recomputation. That is unachievable: labels
// flip, the deed cache expires, and a court can annul an entry (чл. 29 ЗТРРЮЛНЦ) with no rules change
// at all. So the seal is NOT a store — it is re-derived every run — and monotonicity is enforced HERE,
// as a gate, against the export load.mjs writes immediately before it drops the CACBG tables.
//
// The rule: a link that was published last run and is not published now is a REGRESSION unless the
// rules themselves changed. Under an unchanged rules_version nothing licensed the removal, so it is a
// hard finding. Under a changed one it is an intentional event and degrades to a printed diff.
//
// ship-related-persons.mjs's count floor cannot do this job: it compares a COUNT, so a one-for-one
// swap — one true link silently dropped, one gained — leaves it perfectly quiet.
const publishedNow = new Set(published.map((l) => l.link_key));
let priorPublished = null;
try {
  priorPublished = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
} catch (e) {
  // ENOENT is the legitimate first run — there is no prior surface to regress from. Anything else
  // (unreadable, malformed) must not be swallowed into a silent pass of the gate.
  if (e.code !== 'ENOENT') throw e;
}
const vanished = (priorPublished ?? []).filter((p) => !publishedNow.has(p.link_key));
const regressions = vanished.filter((p) => p.rules_version === RULES_VERSION);
for (const p of regressions)
  findings.push({
    axis: 'D_monotonicity',
    link_key: p.link_key,
    eik: p.link_key.split('|')[1] ?? '',
    // The link_key is named explicitly: it is the only handle a human has to go and look at which
    // claim disappeared, and the shared axis report prints the ЕИК alone.
    detail: `${p.link_key} published last run under rules_version ${p.rules_version} (unchanged) and is not published now — nothing licensed this removal`,
  });

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
if (priorPublished === null) {
  console.log(`## monotonicity — no prior export at ${SNAPSHOT}; treating this as a first run\n`);
} else {
  const declared = vanished.filter((p) => p.rules_version !== RULES_VERSION);
  console.log(
    `## monotonicity — ${priorPublished.length} published last run, ${publishedNow.size} now; ` +
      `${regressions.length} regression(s), ${declared.length} declared removal(s)\n`,
  );
  // Declared removals are not findings, but they are never silent: a rules bump is exactly when a
  // human should read which named claims it withdrew.
  for (const p of declared)
    console.log(
      `  - ${p.link_key} removed under a rules change (${p.rules_version} → ${RULES_VERSION})`,
    );
  if (declared.length) console.log('');
}

console.log(`## non-exact provenance (${provenance.length}) — verify each cross-check by eye`);
for (const p of provenance) {
  console.log(`  - ${p.method} [${p.eik}] winner="${p.winner}"`);
  console.log(
    `      evidence: ${p.evidence ? JSON.stringify(p.evidence) : 'NONE FOUND (cross-check would now fail!)'}`,
  );
}

if (findings.length) process.exitCode = 1;
