import { fileDigest } from './build-proof.mjs';
// Adversarial accuracy audit of PUBLISHED interest_links. Independent of load.mjs: it rebuilds the
// name-key → ЕИК map from scratch over the live bidders table and re-proves the libel-critical
// invariant (one distinctive key → exactly one eik_valid ЕИК == the published one) for every
// published link. A finding on one link withholds THAT link (the job reloads without it and audits again);
// it never stops the update. Only a defect that names no link stops the run, and the next day's run retries.
// Read-only: the withheld list is a file beside the build.
//
// Run: node --import ./scripts/cacbg/register-ts.mjs scripts/cacbg/audit.mjs
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
  declarationContinuity,
  CONTINUITY_RULE,
  COMPANY_AUTHOR_BASIS,
} from './declaration-continuity.mjs';
import { namesakeResolver, registryCompanyResolver } from './registry-identity.mjs';
import { declarantGuidEvidence, DECLARANT_GUID_RULE } from './declarant-guid.mjs';
import { documentFingerprint } from './source-identity.mjs';
import { declaredEiks } from './extract-companies.mjs';
import { namesCompany } from './resolve-company.mjs';
import { RULES_VERSION, isSealedFact } from '../tr/evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB = process.env.CACBG_DB || path.join(ROOT, 'data/work/backfill.sqlite');
const STAGING = process.env.CACBG_STAGING || path.join(ROOT, 'scratch/cacbg/staging');
const SNAPSHOT = path.join(STAGING, 'published-snapshot.json');
const WITHHELD = path.join(STAGING, 'audit-withheld.json');
const { companyNameKey } = await import('../../packages/shared/src/company-name-key.ts');

fs.rmSync(`${DB}.audited.json`, { force: true });
fs.rmSync(WITHHELD, { force: true });
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

// Every link's CURRENT status, for the monotonicity gate below. A link that left the published set
// because it was SUPPRESSED is still in this table — the takedown is a status flip, not a delete — and
// distinguishing that from a link that simply stopped being built is the difference between a declared
// removal and a silent recall regression. Read here, while the handle is open.
const statusNow = new Map(
  db
    .prepare('SELECT link_key, status FROM interest_links')
    .all()
    .map((r) => [r.link_key, r.status]),
);

// The only two evidence rungs that publish (ADR-0033 decision 1). Everything else withholds.
const PUBLISHING_EVIDENCE = new Set(['document', 'confirmed']);
// The closed vocabulary for a sealed matched_fact lives in evidence.mjs, next to the code that WRITES
// it — one definition, so the gate can never permit a shape the writer has stopped emitting (or, worse,
// the other way round). `isSealedFact` bounds the seat leg to a settlement's one or two tokens, which is
// what stops a three-part Bulgarian name riding through behind the legitimate `seat:` prefix.

const findings = [];
const flag = (link, axis, detail) =>
  findings.push({ axis, link_key: link.link_key, eik: link.eik, detail });

// Published canonical profiles must agree with durable source membership, not a second name resolver.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='person_sources'").get()) {
  const continuity = db
    .prepare(
      "SELECT * FROM person_identity_evidence WHERE decision='accepted' AND rule_version IN (?,?)",
    )
    .all(CONTINUITY_RULE, DECLARANT_GUID_RULE);
  if (continuity.length) {
    try {
      const inconsistent = db
        .prepare(
          `SELECT count(*) n FROM person_identity_evidence e
        LEFT JOIN person_sources l ON l.id=e.left_source LEFT JOIN person_sources r ON r.id=e.right_source
        LEFT JOIN person_entities p ON p.id=l.entity_id
        WHERE e.rule_version IN (?,?) AND e.decision='accepted'
          AND (l.entity_id IS NULL OR r.entity_id IS NOT l.entity_id OR p.id IS NULL)`,
        )
        .get(CONTINUITY_RULE, DECLARANT_GUID_RULE).n;
      if (inconsistent) throw new Error('accepted continuity does not belong to one author');
      const unsupported = db
        .prepare(
          `SELECT count(*) n FROM person_entities p
        WHERE p.registry_indent IS NULL
          AND EXISTS (SELECT 1 FROM person_sources s WHERE s.entity_id=p.id AND s.active=1)
          AND NOT EXISTS (SELECT 1 FROM person_identity_evidence e
            JOIN person_sources l ON l.id=e.left_source
            JOIN person_sources r ON r.id=e.right_source
            WHERE e.decision='accepted' AND l.entity_id=p.id AND r.entity_id=p.id
              AND (e.rule_version=? OR (e.rule_version=? AND json_extract(e.facts,'$.basis')=?)))`,
        )
        .get(DECLARANT_GUID_RULE, CONTINUITY_RULE, COMPANY_AUTHOR_BASIS).n;
      if (unsupported)
        throw new Error(
          'author without a registry identity lacks a declarant identifier or verified company evidence',
        );
      const raw = fs.readFileSync(path.join(STAGING, 'filings.jsonl'));
      const manifest = JSON.parse(fs.readFileSync(path.join(STAGING, 'manifest.json')));
      if (manifest.schemaVersion !== 8 || manifest.filingsHash !== documentFingerprint(raw))
        throw new Error('declaration continuity input is not the completed extraction');
      const filings = raw.toString().trim().split('\n').filter(Boolean).map(JSON.parse);
      const expected = new Map(
        [
          ...declarantGuidEvidence(filings),
          ...declarationContinuity(filings, registryCompanyResolver(db)),
        ].map((e) => [e.id, e]),
      );
      for (const e of continuity) {
        const candidate = expected.get(e.id);
        if (
          !candidate ||
          ['left_source', 'right_source', 'left_hash', 'right_hash', 'relation', 'facts'].some(
            (k) => candidate[k] !== e[k],
          )
        )
          throw new Error(
            'accepted declaration continuity is not reproducible from current sources',
          );
      }
    } catch (error) {
      findings.push({ axis: 'I_declaration_continuity', detail: error.message });
    }
  }
  const invalidEvidence = db
    .prepare(
      `SELECT count(*) n FROM person_identity_evidence e
    LEFT JOIN person_sources l ON l.id=e.left_source
    LEFT JOIN person_sources r ON r.id=e.right_source
    WHERE e.decision='accepted' AND (e.origin<>'automatic' OR l.id IS NULL OR r.id IS NULL
      OR l.active<>1 OR r.active<>1 OR l.source_hash<>e.left_hash OR r.source_hash<>e.right_hash)`,
    )
    .get().n;
  if (invalidEvidence)
    findings.push({
      axis: 'I_automatic_evidence',
      detail: `${invalidEvidence} accepted identity edges lack automatic, current source evidence`,
    });
  const invalid = new Set(
    db
      .prepare(
        `
    SELECT p.id FROM persons p LEFT JOIN person_entities e ON e.id=p.id
    WHERE p.id LIKE 'person:identity:%' AND (e.id IS NULL OR NOT EXISTS(
      SELECT 1 FROM person_sources s WHERE s.entity_id=p.id AND s.namespace='cacbg' AND s.active=1))
    UNION
    SELECT pl.person_id FROM person_registry_links pl LEFT JOIN person_entities e ON e.id=pl.person_id
    WHERE e.registry_indent IS NULL OR e.registry_indent<>pl.registry_indent
    UNION
    SELECT d.person_id FROM declarations d JOIN person_sources s
      ON s.id='cacbg:'||d.folder_year||':'||d.xml_file AND s.active=1
    WHERE d.person_id<>coalesce(s.entity_id,s.legacy_person_id)
  `,
      )
      .all()
      .map((r) => r.id),
  );
  // A defect of the PERSON, not of one link: withholding the link would leave the person's page — its
  // declarations and registry roles — published on the broken identity. It names no link, so it stops the run.
  const broken = new Set(published.filter((l) => invalid.has(l.person_id)).map((l) => l.person_id));
  for (const person of broken)
    findings.push({
      axis: 'I_source_identity',
      detail: `${person}: published profile disagrees with current identity evidence or source membership`,
    });
}

// History is provenance, never an escape from the publishing evidence gate.
// Check it independently of the loader's status calculation.
const observationsPresent = !!db
  .prepare("SELECT 1 FROM sqlite_master WHERE name='interest_link_observations'")
  .get();
const historyRows = db
  .prepare(
    `SELECT il.link_key, il.eik, il.first_declared_year,
  il.last_declared_year, e.evidence_kind, e.entry_number, e.entry_date, e.live_status,
  h.later_declaration_year, h.registry_role_ended_on,
  ${observationsPresent ? '(SELECT COUNT(*) FROM interest_link_observations o WHERE o.link_key=il.link_key)' : 'NULL'} AS observation_count
  FROM interest_links il JOIN interest_link_evidence e USING(link_key)
  LEFT JOIN interest_link_history h USING(link_key) WHERE il.status='published'`,
  )
  .all();
const validDay = (v) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v ?? '') &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
for (const l of historyRows) {
  if (l.first_declared_year == null && observationsPresent && !l.observation_count)
    flag(
      l,
      'H_missing_observation',
      'An undated published link needs a sourced historical observation',
    );
  if (
    l.later_declaration_year != null &&
    (!/^\d{4}$/.test(l.later_declaration_year) ||
      !/^\d{4}$/.test(l.last_declared_year ?? '') ||
      l.later_declaration_year <= l.last_declared_year)
  )
    flag(l, 'H_later_declaration', 'A later omission must follow the last positive ownership year');
  if (
    ['terminated', 'terminated_manager_still'].includes(l.live_status) &&
    !l.later_declaration_year
  )
    flag(
      l,
      'H_missing_history',
      'A published link with an inferred termination needs dated provenance',
    );
  if (
    l.registry_role_ended_on != null &&
    (l.evidence_kind !== 'document' ||
      !l.entry_number ||
      !validDay(l.entry_date) ||
      !validDay(l.registry_role_ended_on) ||
      l.entry_date >= l.registry_role_ended_on)
  )
    flag(l, 'H_registry_period', 'An ended registry role needs a dated entry before its end');
}
const conflictsFile = path.join(STAGING, 'inventory-conflicts.jsonl');
if (fs.existsSync(conflictsFile)) {
  const publicKeys = new Map(published.map((l) => [l.link_key, l]));
  for (const line of fs.readFileSync(conflictsFile, 'utf8').split('\n').filter(Boolean)) {
    const c = JSON.parse(line);
    const l = publicKeys.get(`${c.personId}|${c.eik}${c.scope === 'family' ? '|family' : ''}`);
    if (!l) continue;
    const observations = observationsPresent
      ? db
          .prepare(
            'SELECT declaration_id, timing, reported_year FROM interest_link_observations WHERE link_key=?',
          )
          .all(l.link_key)
      : [];
    for (const [documents, timing] of [
      [c.positiveDocuments, 'annual'],
      [c.otherDocuments, 'not_listed'],
    ])
      for (const id of documents)
        if (
          !observations.some(
            (o) => o.declaration_id === id && o.timing === timing && o.reported_year === c.year,
          )
        )
          flag(
            l,
            'H_inventory_provenance',
            'Differing inventories need both dated source observations',
          );
  }
}

const namesakeOf = namesakeResolver(db);
// The names the register may show for a link's holder: every spelling of the declarant for their own stake,
// the relatives their declarations name as stake holders for a family one. Read on the first namesake link
// only, so older inputs without these tables still audit.
const hasTable = (name) => db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name);
let holderStmts;
// The loader asks the register about the holder each declaration names for THIS stake, one declaration at
// a time: for a family stake, the relatives that declaration lists against this company. The audit asks the
// same question per declaration (the link's own, where the observations table records them) and accepts the
// link when one of them settles on its ЕИК — pooling every declaration's relatives would see two holders in
// two partidas where the loader saw one in each.
const holderNameSets = (l, companyNames) => {
  holderStmts ??= {
    person: db.prepare('SELECT name FROM persons WHERE id = ?'),
    sources: hasTable('person_sources')
      ? db.prepare(
          'SELECT name FROM person_sources WHERE active=1 AND (entity_id = ? OR legacy_person_id = ?)',
        )
      : null,
    relatives: hasTable('related_persons_internal')
      ? db.prepare(`SELECT rp.declaration_id, rp.related_name name, rp.info FROM related_persons_internal rp
          JOIN declarations d ON d.id = rp.declaration_id
          WHERE d.person_id = ? AND rp.related_kind = 'stake_holder'`)
      : null,
    observed: hasTable('interest_link_observations')
      ? db.prepare(
          'SELECT DISTINCT declaration_id FROM interest_link_observations WHERE link_key = ?',
        )
      : null,
  };
  const names = (rows) => [...new Set(rows.filter(Boolean).map((r) => r.name))];
  if (l.relation !== 'related')
    return [
      names([
        holderStmts.person.get(l.person_id),
        ...(holderStmts.sources?.all(l.person_id, l.person_id) ?? []),
      ]),
    ];
  const own = new Set((holderStmts.observed?.all(l.link_key) ?? []).map((r) => r.declaration_id));
  const byDeclaration = new Map();
  for (const r of holderStmts.relatives?.all(l.person_id) ?? []) {
    if (own.size && !own.has(r.declaration_id)) continue;
    if (!namesCompany(r.info ?? '', 'registry_namesake', companyNames)) continue;
    byDeclaration.set(r.declaration_id, [...(byDeclaration.get(r.declaration_id) ?? []), r]);
  }
  return [...byDeclaration.values()].map(names);
};
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
  } else if (l.match_method === 'registry_namesake') {
    // Several winners share the name; the register picks the one whose partida names the holder.
    // Re-ask it from this database, so a link the register no longer supports cannot stay published.
    if (
      !holderNameSets(l, [...rec.names]).some(
        (holders) => namesakeOf([...rec.valid], holders) === l.eik,
      )
    )
      flag(
        l,
        'A_namesake_unproven',
        `key ${l.entity_key} → {${[...rec.valid].join(',')}}; the register does not name the holder in ${l.eik} alone, or a namesake partida is unread`,
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
  if (!isSealedFact(l.matched_fact))
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
const bidderNames = db.prepare(
  'SELECT DISTINCT name FROM bidders WHERE eik_normalized = ? AND eik_valid = 1',
);
for (const l of nonExact) {
  const rows = rawForPerson.all(l.person_id);
  const names = [...new Set([l.bidder_name, ...bidderNames.all(l.eik).map((b) => b.name)])];
  const hit = rows.find((r) => {
    const t = r.entity_raw || '';
    // Boundary-safe, the same test the resolver applied (ADR-0016); a stated ЕИК must be this one.
    return (
      (l.match_method !== 'declared_eik' || declaredEiks(t).includes(l.eik)) &&
      namesCompany(t, l.match_method, names)
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

// D. What left the surface since the last run — reported, never a reason to stop.
//
// Seals are re-derived every run, and a link can leave for ordinary reasons: a label flips, a deed
// changes, a declaration is taken down. Losing a link costs that one link until the source brings it
// back; stopping the run over it costs every other update of the week. So the comparison stays as a
// printed diff and an event, and nothing here can fail the build.
const publishedNow = new Set(published.map((l) => l.link_key));
let priorPublished = null;
try {
  priorPublished = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
} catch (e) {
  // ENOENT is the legitimate first run. An unreadable snapshot only costs this report.
  if (e.code !== 'ENOENT') console.warn(`! unreadable prior snapshot: ${e.message}`);
}
const vanished = (priorPublished ?? []).filter((p) => !publishedNow.has(p.link_key));
const removalGround = (p) =>
  p.rules_version == null
    ? `the pre-evidence regime — now under ${RULES_VERSION}`
    : p.rules_version !== RULES_VERSION
      ? `a rules change (${p.rules_version} → ${RULES_VERSION})`
      : p.corrected === true
        ? 'an acknowledged input correction'
        : statusNow.get(p.link_key) === 'suppressed'
          ? 'a suppression (an ADR-0031 takedown, or withheld by this run’s audit)'
          : 'the source no longer supports it';

// Report
const byAxis = {};
for (const f of findings) (byAxis[f.axis] ??= []).push(f);
console.log(`# CACBG published-link accuracy audit\n`);
console.log(`published links audited: ${published.length}`);
console.log(`hard findings: ${findings.length}\n`);
for (const [axis, fs] of Object.entries(byAxis)) {
  console.log(`## ${axis} — ${fs.length}`);
  for (const f of fs.slice(0, 20)) console.log(`  - [${f.eik ?? '-'}] ${f.detail}`);
  console.log('');
}
if (priorPublished === null) {
  console.log(`## removed links — no prior export at ${SNAPSHOT}; treating this as a first run\n`);
} else {
  console.log(
    `## removed links — ${priorPublished.length} published last run, ${publishedNow.size} now; ` +
      `${vanished.length} removed\n`,
  );
  for (const p of vanished) console.log(`  - ${p.link_key} removed: ${removalGround(p)}`);
  if (vanished.length) console.log('');
  console.log(
    JSON.stringify({
      event: 'declarations_links_removed',
      before: priorPublished.length,
      after: publishedNow.size,
      removed: vanished.length,
    }),
  );
}

console.log(`## non-exact provenance (${provenance.length}) — verify each cross-check by eye`);
for (const p of provenance) {
  console.log(`  - ${p.method} [${p.eik}] winner="${p.winner}"`);
  console.log(
    `      evidence: ${p.evidence ? JSON.stringify(p.evidence) : 'NONE FOUND (cross-check would now fail!)'}`,
  );
}

if (findings.length) {
  process.exitCode = 1;
  // A finding that names a link costs that link. Anything else names no link to withhold, and it is the
  // job that decides what to do with the list: this script only reports and writes nothing else.
  const links = [...new Set(findings.flatMap((f) => (f.link_key ? [f.link_key] : [])))];
  fs.writeFileSync(
    WITHHELD,
    JSON.stringify({ links, structural: findings.filter((f) => !f.link_key).length }),
  );
}

// Bind successful verification to the exact closed file that ship will read.
if (!findings.length && fs.existsSync(`${DB}.build.json`)) {
  const proof = JSON.parse(fs.readFileSync(`${DB}.build.json`, 'utf8'));
  if (proof.complete === true)
    fs.writeFileSync(
      `${DB}.audited.json`,
      JSON.stringify({
        ...proof,
        sha256: await fileDigest(DB),
        auditedAt: new Date().toISOString(),
      }),
    );
}
