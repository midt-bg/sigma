// Phase 1 — productionized loader/resolver. Reads the extracted staging (holdings.jsonl / related.jsonl),
// resolves each declared interest to a winning bidder's ЕИК via the ONE production normalizer, and
// persists the свързани-лица domain (persons / declarations / declared_interests / interest_links /
// related_persons_internal) into the target SQLite/D1 per migration 0002. Idempotent: it rebuilds the
// domain tables from staging each run; suppressions are external (version-controlled list, ADR-0031).
//
// Certainty 1.0 comes from the resolver, not a loader gate: it publishes ONLY a key that maps to exactly
// one valid winner ЕИК; any key spanning >1 valid ЕИК is quarantined (never published) and reported as
// telemetry. The 0-over-merge libel proof is the labelled company-name-key.test.ts (ADR-0027), not this
// loader. Only tier A|B links are 'published'; every link carries provenance + matcher_version.
//
// Run: node --import ./scripts/cacbg/register-ts.mjs scripts/cacbg/load.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  nameDistinctiveness,
  seatConfirmed,
  publishTier,
  temporalStatus,
  localityToken,
  closelyHeldForm,
} from './classify.mjs';
import { companyCandidates, declaredEiks } from './extract-companies.mjs';
import { fingerprint, loadSuppressions, SUPPRESSION_KEY_VERSION } from './suppressions.mjs';
import { canonicalInstitution } from './institutions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB = process.env.CACBG_DB || path.join(ROOT, 'data/work/backfill.sqlite');
const STAGING = process.env.CACBG_STAGING || path.join(ROOT, 'scratch/cacbg/staging');
const MIGRATION = path.join(ROOT, 'packages/db/migrations/0003_related_persons_foundation.sql');
const REPORT = path.join(STAGING, 'findings.md');
const MATCHER_VERSION = 'cnk-1+classify-1'; // bump when the normalizer or classify logic changes
const { companyNameKey, isMatchableKey } =
  await import('../../packages/shared/src/company-name-key.ts');

const norm = (s) =>
  String(s ?? '')
    .normalize('NFC')
    .toUpperCase()
    .replace(/[\s.\-–—]+/g, ' ')
    .trim();
const yr = (s) => {
  const m = String(s ?? '').match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : NaN;
};
const readJsonl = (f) =>
  fs.existsSync(f)
    ? fs
        .readFileSync(f, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

const db = new DatabaseSync(DB);
db.exec('PRAGMA foreign_keys=ON');
// Suppressions live in a VERSION-CONTROLLED, HMAC-fingerprinted list (ADR-0031), NOT a DB table — so a
// takedown survives a fresh-CI-runner rebuild and never ships the „who was taken down" signal to prod.
// Loaded before the wipe; fail-closed if the list is non-empty but SUPPRESSION_SALT is unset.
const SUPP_LIST =
  process.env.CACBG_SUPP_LIST || path.join(ROOT, 'scripts/cacbg/link-suppressions.jsonl');
const SUPP_SALT = process.env.SUPPRESSION_SALT ?? '';
const suppEntries = loadSuppressions(SUPP_LIST, SUPP_SALT, SUPPRESSION_KEY_VERSION);
const suppressedFp = new Set(suppEntries.map((e) => e.fp));
// B3 unused-suppression gate: every listed fingerprint MUST match exactly one built link. Track which get
// used; a fingerprint that matched nothing (a stale/mis-keyed takedown) fails the build after the load loop.
const usedSuppressions = new Set();
// Full idempotent rebuild that also picks up schema changes: drop the CACBG tables (children first —
// FK-safe) and re-apply the migration. Nothing to preserve — suppressions are external now.
for (const t of [
  'interest_link_authorities',
  'interest_links',
  'declared_interests',
  'related_persons_internal',
  'declarations',
  'persons',
])
  db.exec(`DROP TABLE IF EXISTS ${t}`);
db.exec(fs.readFileSync(MIGRATION, 'utf8'));
// A link is suppressed when its fingerprint is in the list. Only compute the HMAC when the list is
// non-empty (size>0 ⇒ salt present, else the loader above threw), so the empty common path skips crypto.
const isSuppressed = (linkKey) => {
  if (suppressedFp.size === 0) return false;
  const fp = fingerprint(linkKey, SUPP_SALT);
  if (!suppressedFp.has(fp)) return false;
  usedSuppressions.add(fp); // mark this listed suppression as having matched a real link (B3 gate)
  return true;
};

// --- bidder index + libel gate ------------------------------------------------------------------
const bidders = db
  .prepare('SELECT id, name, eik_normalized eik, eik_valid valid, settlement FROM bidders')
  .all();
const byKey = new Map();
const bidderByEik = new Map(); // valid winners, for declared-ЕИК-in-text matching
for (const b of bidders) {
  const k = companyNameKey(b.name);
  // A degenerate bidder name (empty/quote-only) folds to the empty key; indexing it would let every
  // degenerate declared name cross-match into this bucket — an over-merge. Keep it out of the name map
  // (it can still match by ЕИК via bidderByEik below, which is exact).
  if (isMatchableKey(k)) {
    if (!byKey.has(k)) byKey.set(k, new Map());
    byKey.get(k).set(b.eik ?? `name:${b.name}`, b);
  }
  if (b.eik && b.valid) bidderByEik.set(b.eik, b);
}

// Resolve a declared entity string to a single winner ЕИК, deterministically. Strongest signal wins:
//   exact_name_key  — the clean declared name normalizes to exactly one winner ЕИК.
//   declared_eik    — the official wrote the ЕИК in the text AND the winner's name also appears there
//                     (cross-check blocks a typo'd ЕИК pointing at the wrong company).
//   extracted_name  — a „NAME"-ФОРМА pulled from prose normalizes to exactly one winner ЕИК.
// Returns {eik, method} | {ambiguous:true} | null. Never guesses across >1 ЕИК.
function resolveEntity(entity) {
  const key = companyNameKey(entity);
  const m = byKey.get(key);
  if (m) {
    const eiks = new Set([...m.values()].filter((v) => v.eik && v.valid).map((v) => v.eik));
    if (eiks.size === 1) return { eik: [...eiks][0], method: 'exact_name_key' };
    if (eiks.size > 1) return { ambiguous: true };
  }
  for (const de of declaredEiks(entity)) {
    const b = bidderByEik.get(de);
    if (!b) continue;
    const winnerKey = companyNameKey(b.name);
    // An empty winner key can't be a meaningful cross-check (a degenerate candidate could spuriously equal
    // it). Skip it; the ЕИК alone isn't enough here by design.
    if (!isMatchableKey(winnerKey)) continue;
    // Name cross-check: the winner's фирма must appear as a proper „NAME" ФОРМА candidate in the declared
    // text (boundary-safe, exact key). A raw `key.includes(winnerKey)` was REMOVED — it matched a winner
    // name embedded MID-TOKEN in an unrelated фирма („СТРОЙ 1" inside „МЕГАСТРОЙ 15"), which with a typo'd-
    // but-valid ЕИК would attach the wrong winner's contracts to the official (a false conflict; ADR-0016).
    if (companyCandidates(entity).some((c) => companyNameKey(c) === winnerKey)) {
      return { eik: de, method: 'declared_eik' };
    }
  }
  for (const c of companyCandidates(entity)) {
    const cm = byKey.get(companyNameKey(c));
    if (!cm) continue;
    const eiks = new Set([...cm.values()].filter((v) => v.eik && v.valid).map((v) => v.eik));
    if (eiks.size === 1) return { eik: [...eiks][0], method: 'extracted_name' };
  }
  return null;
}
// Is this name key backed by exactly one valid winner ЕИК across the whole bidder set? The distinctiveness
// tier rests on this being true; declared_eik/extracted_name bypass the resolver's own single-ЕИК guard,
// so the tier layer must re-assert global name-uniqueness itself.
const nameGloballyUnique = (key) => {
  const m = byKey.get(key);
  if (!m) return false;
  return new Set([...m.values()].filter((v) => v.eik && v.valid).map((v) => v.eik)).size === 1;
};
const METHOD_RANK = { exact_name_key: 3, declared_eik: 2, extracted_name: 1 };
// Ambiguous name keys — TELEMETRY, not a gate (ADR-0027). A companyNameKey that maps to >1 distinct
// valid winner ЕИК. The resolver already QUARANTINES these (resolveEntity → {ambiguous:true}); they
// never publish, so they carry no libel exposure — this only sizes the ambiguous tail for Phase 0. On the
// real winner corpus every such collision is presentation-only (case/quotes/space): a generic name shared
// by distinct entities (e.g. „ВОДОСНАБДЯВАНЕ И КАНАЛИЗАЦИЯ ЕООД" → several regional utilities) or a
// feed-side duplicate/typo'd ЕИК on one registered name. It is deliberately tied to NO exit code.
// This is NOT the over-merge libel proof: that is the LABELLED company-name-key.test.ts (ground-truth
// companyId, bar 0). A self-comparison of the winner set cannot reproduce it — the previous `strictKey`
// tiebreak stripped a superset of what companyNameKey folds, so it was a structural false-zero that still
// printed „0 over-merges" and could exit(1) (review #226).
const ambiguousKeys = [];
for (const [key, m] of byKey) {
  const valid = [...m.values()].filter((v) => v.eik && v.valid);
  const eiks = new Set(valid.map((v) => v.eik));
  if (eiks.size > 1) {
    ambiguousKeys.push({ key, eiks: [...eiks], names: [...new Set(valid.map((v) => v.name))] });
  }
}

// --- load staging → persons / declarations / declared_interests ; resolve → agg ------------------
const insPerson = db.prepare('INSERT OR IGNORE INTO persons(id,name) VALUES(?,?)');
const insDecl = db.prepare(
  'INSERT OR IGNORE INTO declarations(id,person_id,xml_file,control_hash,folder_year,declared_year,template,category,institution,position,source_url) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
);
const insDI = db.prepare(
  'INSERT INTO declared_interests(id,declaration_id,entity_raw,entity_key,kind,detail,timing,seat) VALUES(?,?,?,?,?,?,?,?)',
);
const insRP = db.prepare(
  'INSERT INTO related_persons_internal(id,declaration_id,related_name,related_kind,info,timing) VALUES(?,?,?,?,?,?)',
);
// Person grain is (name, institution) — NEVER a bare name (spec §4: „homonym merge is the failure to
// avoid"). Two „Георги Иванов" at different institutions are different people; keying on the name alone
// merges them into one /conflicts page carrying both their companies (false attribution). Institution is
// normalized through the same key so a person's institution-string variants fold together, keeping identity
// stable across their filing years — which the E11 divestment horizon (keyed on person_id) depends on.
// register_year/position are deliberately EXCLUDED (ADR-0026): both would split one official across
// years/promotions, fragmenting identity and blinding the cross-year divestment tracking.
// Institution is canonicalized (N10) so an official's „МВР" / „Министерство на вътрешните работи" filings
// fold to ONE identity instead of splitting into two person-pages. An unknown/ambiguous string passes
// through unchanged (a safe split), never a wrong merge.
const personId = (name, institution) =>
  `person:${companyNameKey(name)}|${companyNameKey(canonicalInstitution(institution))}`;
// Financial-interest kinds (a genuine stake), as opposed to management-only or listed securities.
const OWN_KINDS = new Set(['shares', 'participation', 'sole_trader']);
const agg = new Map();
let diN = 0,
  noMatch = 0,
  quarantined = 0,
  immaterialFamily = 0,
  unknownHolder = 0,
  namelessInstitution = 0,
  namelessPerson = 0;
// §2 ал.3 ПЗР canary (rail #3): every MATERIAL family holding must originate from a PUBLIC asset declaration.
// parse.mjs builds family scope SOLELY from parseAssets/<PublicPerson> (templateType 'assets'), so this map —
// material family holdings bucketed by their source declaration's template — must stay 100% 'assets'. Any other
// bucket = a relative's stake leaking from a non-public source (a consent/libel breach). Telemetry tripwire.
const familyMaterialByTemplate = new Map();

// Divest horizon, PER DECLARATION TYPE (`${pid}|${template}` → latest year the person filed a declaration of
// that type). A stake declared in a type-T document is only withdrawn when a LATER type-T declaration omits it;
// a later declaration of a DIFFERENT type — which for this person may structurally never carry company holdings
// — must not count, or its silence would read as a sale and drop a TRUE link (#226, Todor B1: 13% of holders
// declare a stake ONLY in the interests declaration). One record per declaration incl. empty / no-material ones,
// so a same-type divest-to-ZERO still advances the horizon. An absent/typeless file just yields no match ⇒ the
// link is kept (fail-safe: never withdraw on missing evidence).
const filingMaxByPersonType = new Map();
for (const f of readJsonl(path.join(STAGING, 'filings.jsonl'))) {
  if (!isMatchableKey(companyNameKey(f.person))) continue;
  const fy = yr(f.year);
  if (!Number.isFinite(fy)) continue;
  const k = `${personId(f.person, f.institution)}|${f.template ?? ''}`;
  filingMaxByPersonType.set(k, Math.max(filingMaxByPersonType.get(k) ?? fy, fy));
}

db.exec('BEGIN');
for (const h of readJsonl(path.join(STAGING, 'holdings.jsonl'))) {
  // A degenerate official name folds to the empty person key (`person:`), which would MERGE every such
  // official into one identity and mis-attribute their links. Can't attribute a stake to a nameless person
  // — skip the row (bad-input, not a resolvable holding).
  if (!isMatchableKey(companyNameKey(h.person))) {
    namelessPerson++;
    continue;
  }
  const pid = personId(h.person, h.institution);
  // Namespace the declaration id by FOLDER, not the bare xmlFile. The register splits years across
  // suffixed folders; keying on the basename alone means two officials whose declarations share an
  // xmlFile across folders collapse to one `did` under INSERT OR IGNORE — the second's interests would
  // attach to the first (cross-person mis-attribution, the libel risk this surface exists to avoid).
  // folder+xmlFile is unique by construction, independent of any GUID-uniqueness assumption.
  const did = `decl:${h.folder}:${h.xmlFile}`;
  insPerson.run(pid, h.person);
  insDecl.run(
    did,
    pid,
    h.xmlFile,
    h.controlHash ?? null,
    h.folder,
    h.year ?? null,
    h.template,
    h.category ?? '',
    h.institution ?? '',
    h.position ?? '',
    `https://register.cacbg.bg/${h.folder}/${h.xmlFile}`,
  );
  const key = companyNameKey(h.entity);
  insDI.run(
    `di:${did}:${diN++}`,
    did,
    h.entity,
    key,
    h.kind,
    h.detail ?? '',
    h.timing ?? 'annual',
    h.seat ?? '',
  );
  // Unknown holder (B4): the holder cell is neither confidently the declarant's own name nor confidently a
  // relative's (an ambiguous 1-token-different / initials-only cell). Counted NOWHERE — it forms no link and
  // never advances a scope's ownership horizon — so a name we cannot resolve never pollutes a published
  // number (the self or family leaderboard). Retained in declared_interests for census.
  if (h.holderRelation === 'unknown') {
    unknownHolder++;
    continue;
  }
  // N10: the person grain is (name, institution). An EMPTY institution (after canonicalization) cannot
  // distinguish two same-named officials, so forming a link would risk attributing one person's stake to a
  // homonym (false attribution — libel). Withhold from link formation; the declaration + declared interest
  // are already recorded above for census. Counted so the dropped volume is visible in the Phase-0 report.
  if (!isMatchableKey(companyNameKey(canonicalInstitution(h.institution)))) {
    namelessInstitution++;
    continue;
  }
  // scope = whose stake this is. holderRelation='related' ⇒ a CLOSE RELATIVE's stake declared by the
  // official (anonymized downstream — the relative's name never enters staging). Everything else is the
  // official's own. Materiality gate = a real financial-interest kind in a CLOSELY-HELD company; listed
  // securities (АД/ЕАД) and management-only roles are not ownership (the „11 listed shares → €88M" trap).
  const scope = h.holderRelation === 'related' ? 'family' : 'self';
  const material = OWN_KINDS.has(h.kind) && closelyHeldForm(h.entity);
  // A family row is ONLY meaningful as an ownership signal — a relative's management role or listed
  // securities is not a publishable interest — so immaterial family rows form no link (still in declared_interests).
  if (scope === 'family' && !material) {
    immaterialFamily++;
    continue;
  }
  // §2 ал.3 canary: a material family holding reached link formation — bucket it by its source template so the
  // report can prove the rail-3 by-construction invariant (family ⟹ 'assets') actually held on this corpus.
  if (scope === 'family') {
    const t = h.template || '—';
    familyMaterialByTemplate.set(t, (familyMaterialByTemplate.get(t) ?? 0) + 1);
  }
  // resolve (clean name → declared ЕИК → extracted-from-prose name)
  const res = resolveEntity(h.entity);
  if (!res || res.ambiguous) {
    if (res?.ambiguous) quarantined++;
    else noMatch++;
    continue;
  }
  const eik = res.eik;
  const bidder = bidderByEik.get(eik);
  const gid = `${pid}|${eik}|${scope}`; // self and family stakes in the same company are distinct claims
  let rec = agg.get(gid);
  if (!rec)
    rec = agg
      .set(gid, {
        pid,
        eik,
        scope,
        bidder,
        person: h.person,
        key: companyNameKey(bidder.name),
        kinds: new Set(),
        hasMaterialOwn: false,
        declYears: new Set(),
        ownYears: new Set(),
        templates: new Set(), // declaration types this stake was declared under — its divest horizon (B1/#226)
        seats: new Set(),
        institutions: new Set(),
        method: res.method,
      })
      .get(gid);
  if (METHOD_RANK[res.method] > METHOD_RANK[rec.method]) rec.method = res.method; // strongest evidence wins
  rec.kinds.add(h.kind);
  if (h.template) rec.templates.add(h.template);
  const y = yr(h.year);
  if (Number.isFinite(y)) rec.declYears.add(y);
  // Per-company material ownership years (this resolved winner only) — `recOwnMax` below dates the link to its
  // last declaration, compared against the person's latest filing OF THE SAME declaration type(s) to detect
  // divestment (§8/E11). Material-ownership only: management filing cadence is unverified (spec §6). A
  // divest-to-ZERO (sell everything, file an empty same-type declaration) is caught too (B1): filings.jsonl
  // carries a record per declaration, so a stake absent from a later even-empty type-T filing is withdrawn.
  if (material) {
    rec.hasMaterialOwn = true;
    if (Number.isFinite(y)) rec.ownYears.add(y);
  }
  if (h.seat) rec.seats.add(h.seat);
  if (h.institution) rec.institutions.add(h.institution);
}
// related persons (internal/PII)
let rpN = 0;
for (const r of readJsonl(path.join(STAGING, 'related.jsonl'))) {
  // Same folder-namespaced key as the holdings loop — so the related rows of a declaration resolve to
  // the very declaration the holdings loop inserted (and so cross-folder xmlFile clashes can't merge).
  const did = `decl:${r.folder}:${r.xmlFile}`;
  if (!db.prepare('SELECT 1 FROM declarations WHERE id=?').get(did)) {
    insPerson.run(personId(r.person, r.institution), r.person);
    insDecl.run(
      did,
      personId(r.person, r.institution),
      r.xmlFile,
      null,
      r.folder,
      r.year ?? null,
      'interests',
      '',
      r.institution ?? '',
      '',
      `https://register.cacbg.bg/${r.folder}/${r.xmlFile}`,
    );
  }
  insRP.run(
    `rp:${did}:${rpN++}`,
    did,
    r.related_name,
    r.related_kind,
    r.info ?? '',
    r.timing ?? 'current',
  );
}
db.exec('COMMIT');

// --- enrich each (person,eik) → interest_links (+ per-authority breakdown) -----------------------
const contractStmt = db.prepare(
  "SELECT strftime('%Y', c.signed_at) yr, a.id auth_id, a.name authority, c.amount_eur eur FROM contracts c JOIN tenders t ON t.id=c.tender_id JOIN authorities a ON a.id=t.authority_id JOIN bidders b ON b.id=c.bidder_id WHERE b.eik_normalized=?",
);
const insLink = db.prepare(
  'INSERT INTO interest_links(id,link_key,person_id,bidder_id,eik,entity_key,match_method,matcher_version,publish_tier,relation,interest_class,contemporaneous,own_institution,evidence_count,first_declared_year,last_declared_year,contract_count,contract_value_eur,first_contract_year,last_contract_year,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
);
const insILA = db.prepare(
  'INSERT OR IGNORE INTO interest_link_authorities(link_key,authority_id,authority_name,contract_count,value_eur,own) VALUES(?,?,?,?,?,?)',
);
// classify one authority (whose name may be a ';'-joined blob) against the official's institutions.
// exact = deterministic name equality; name_contains/locality = DISCLOSED heuristics (candidate, not proof).
const OWN_RANK = { exact: 3, name_contains: 2, locality: 1, none: 0 };
function authOwn(authorityName, instNorms, instNormsLong, locTokens) {
  const parts = String(authorityName)
    .split(';')
    .map((s) => norm(s))
    .filter(Boolean);
  if (parts.some((p) => instNorms.includes(p))) return 'exact';
  // heuristic: a LONG institution name (≥12 chars — guards against short-abbreviation false positives)
  // that is a normalized substring of an authority component or vice versa (e.g. „Народно събрание"
  // ⊂ „Народно събрание на Република България"). Disclosed, not deterministic.
  if (
    instNormsLong.length &&
    parts.some((p) => instNormsLong.some((i) => p.includes(i) || i.includes(p)))
  )
    return 'name_contains';
  if (locTokens.length && parts.some((p) => locTokens.some((t) => p.includes(t))))
    return 'locality';
  return 'none';
}
// Distinct officials who declared each company (ЕИК). A private interest has ONE owner-declarant; a
// public body's board is declared by MANY rotating members — the deterministic ex-officio tell (ADR-0019).
const declarantsByEik = new Map();
for (const rec of agg.values()) {
  if (rec.scope !== 'self') continue; // ex-officio tell counts SELF declarants of a public board only
  let s = declarantsByEik.get(rec.eik);
  if (!s) declarantsByEik.set(rec.eik, (s = new Set()));
  s.add(rec.pid);
}
// Interpretation class for the published surface — separates genuine private financial interest from
// ex-officio public-board roles so the headline never treats an appointed civil servant as a conflict.
// A family-scope link is its own class (relative's declared stake, official anonymized as свързано лице).
function interestClass(rec, relation) {
  if (rec.scope === 'family') return 'family_ownership';
  if (relation === 'owns' || relation === 'owns+manages') return 'private_ownership';
  return (declarantsByEik.get(rec.eik)?.size ?? 1) > 1 ? 'ex_officio_board' : 'management_role';
}
db.exec('BEGIN');
for (const rec of agg.values()) {
  // Immaterial self record (listed securities / АД-form, no management role): recorded in
  // declared_interests for census, but it is not a publishable financial interest — form no link.
  if (rec.scope === 'self' && !rec.hasMaterialOwn && !rec.kinds.has('management')) continue;
  const declYears = [...rec.declYears];
  const instNorms = [...rec.institutions].map(norm);
  const instNormsLong = instNorms.filter((i) => i.length >= 12);
  const locTokens = [...rec.institutions].map(localityToken).filter(Boolean);
  const years = new Set();
  let cCount = 0,
    cValue = 0,
    hasValue = false;
  const perAuth = new Map(); // auth_id → {name, count, value, own}
  for (const r of contractStmt.all(rec.eik)) {
    cCount++;
    if (r.yr) years.add(Number(r.yr));
    if (r.eur != null) {
      cValue += r.eur;
      hasValue = true;
    }
    let a = perAuth.get(r.auth_id);
    if (!a)
      a = perAuth
        .set(r.auth_id, { name: r.authority ?? '', count: 0, value: 0, own: 'none' })
        .get(r.auth_id);
    a.count++;
    if (r.eur != null) a.value += r.eur;
  }
  const seatOk = [...rec.seats].some((s) => seatConfirmed(s, rec.bidder.settlement));
  // A declarant-provided ЕИК is the national unique identifier (ЗТРРЮЛНЦ) — it resolves the winner
  // deterministically even behind a generic or winner-colliding name, so a declared_eik match publishes
  // on its own basis (A_eik), never held for name-genericness. This is at least as certain as the seat
  // proof that rescues an otherwise-generic name (A_seat) — the ЕИК IS the identity, not a heuristic.
  // Name-only methods (exact_name_key / extracted_name) still ride the distinctiveness/seat gate below:
  // a globally non-unique winner name (e.g. „Водоснабдяване и канализация ЕАД" → 2 valid ЕИК in different
  // towns) can never be name-distinctive, so it publishes only if the declared SEAT disambiguates, else held.
  const nameUnique = nameGloballyUnique(rec.key);
  const tier =
    rec.method === 'declared_eik'
      ? 'A_eik'
      : publishTier({
          seatOk,
          distinctiveness: nameUnique ? nameDistinctiveness(rec.key) : 'generic',
        });
  const contemporaneous = [...years].some(
    (cy) => temporalStatus(declYears, cy) === 'contemporaneous',
  )
    ? 1
    : 0;
  // link-level own_institution = strongest per-authority verdict (exact > name_contains > locality > none)
  let ownInst = 'none';
  for (const [, a] of perAuth) {
    a.own = authOwn(a.name, instNorms, instNormsLong, locTokens);
    if (OWN_RANK[a.own] > OWN_RANK[ownInst]) ownInst = a.own;
  }
  // Family scope = the official's declaration discloses a related person's stake (relation 'related').
  // Self scope: owns / manages / owns+manages from material ownership + management roles.
  const relation =
    rec.scope === 'family'
      ? 'related'
      : rec.kinds.has('management')
        ? rec.hasMaterialOwn
          ? 'owns+manages'
          : 'manages'
        : 'owns'; // hasMaterialOwn is guaranteed here (immaterial self skipped above)
  const iClass = interestClass(rec, relation);
  // Self link_key stays `pid|eik` (preserves human-curated suppression keys); family is a distinct claim.
  const linkKey = rec.scope === 'family' ? `${rec.pid}|${rec.eik}|family` : `${rec.pid}|${rec.eik}`;
  // E11 divestment: an ownership link whose company is absent from the scope's LATEST ownership filing has
  // ended → 'withdrawn' (excluded from the published surface, like held/suppressed). Ownership relations
  // (self owns/owns+manages, family related), compared against material-ownership years for that scope.
  const recOwnMax = rec.ownYears.size ? Math.max(...rec.ownYears) : null;
  // Divestment horizon = the person's latest filing year AMONG the declaration type(s) this stake was declared
  // under (rec.templates). A later filing of a different type is ignored: for a holder who declares a company
  // only in the interests declaration, a subsequent asset-only declaration carries no company section, so its
  // silence is not evidence of a sale — counting it would withdraw a TRUE link (#226, Todor B1). Same-type
  // filings (incl. empty ones) still advance it, so a divest-to-ZERO is caught. No same-type later filing ⇒
  // horizon stays at/under recOwnMax ⇒ the link is kept (fail-safe on missing evidence).
  let horizon = -Infinity;
  for (const t of rec.templates) {
    const fm = filingMaxByPersonType.get(`${rec.pid}|${t}`);
    if (fm != null) horizon = Math.max(horizon, fm);
  }
  const divested =
    (relation === 'owns' || relation === 'owns+manages' || relation === 'related') &&
    recOwnMax != null &&
    Number.isFinite(horizon) &&
    horizon > recOwnMax;
  // status must be SELF-DESCRIBING in D1: 'published' means "on the public surface", not merely "passed the
  // tier gate". Both the official's OWN material ownership (private_ownership) AND a close relative's declared
  // stake (family_ownership) surface, identically (ADR-0032, superseding ADR-0030): the public-interest basis
  // is the same declared-stake × procurement-winner signal, and the relative's NAME never enters staging, the
  // DB or the DTO (parse.mjs keeps only holderRelation), nor is the relationship type ever asserted — the card
  // says only „свързано лице". § 2 ал. 3 ПЗР (asset declaration not public for some admin staff) is honored
  // BY CONSTRUCTION: family_ownership can arise only from the ASSET declaration (parse.mjs parseAssets /
  // <PublicPerson>), so a person whose asset declaration is not published at source has no family link to
  // surface — we never exceed the source. ex_officio_board / management_role never surface. Non-surfaced
  // classes that would otherwise publish get 'internal'; suppressed/withdrawn/held still take precedence.
  // Zero-contract gate (I5): the surface's whole premise is „a stake in a company that WON public money".
  // A match to a bidder with no recorded contracts (cCount===0 — a winner row with every contract deduped/
  // filtered away, or a name-only match to a non-winning entity) has no procurement conflict to show: the
  // card would read „0 договори · 0 €". Such a link is collected but never surfaces — treat it like a
  // non-surfaced class ('internal'), not 'published'. cValue can legitimately be 0 with cCount>0 (contracts
  // whose amount is unknown/NULL) — that is a real conflict of unknown value, so gate on COUNT, not value.
  const surfaces = (iClass === 'private_ownership' || iClass === 'family_ownership') && cCount > 0;
  const status = isSuppressed(linkKey)
    ? 'suppressed'
    : divested
      ? 'withdrawn'
      : tier === 'C_hold'
        ? 'held'
        : surfaces
          ? 'published'
          : 'internal';
  const yrs = [...years];
  insLink.run(
    `il:${linkKey}`,
    linkKey,
    rec.pid,
    rec.bidder.id,
    rec.eik,
    rec.key,
    rec.method,
    MATCHER_VERSION,
    tier,
    relation,
    iClass,
    contemporaneous,
    ownInst,
    rec.kinds.size,
    declYears.length ? String(Math.min(...declYears)) : null,
    declYears.length ? String(Math.max(...declYears)) : null,
    cCount,
    hasValue ? cValue : null,
    yrs.length ? String(Math.min(...yrs)) : null,
    yrs.length ? String(Math.max(...yrs)) : null,
    status,
  );
  for (const [auth_id, a] of perAuth)
    insILA.run(linkKey, auth_id, a.name, a.count, a.value || null, a.own);
}
db.exec('COMMIT');

// B3 unused-suppression gate: every entry in the version-controlled list MUST have matched exactly one built
// link. A fingerprint that matched NOTHING (a changed institution in the key, a reformatted ЕИК, or a wrong
// salt) means a taken-down link would silently return to the public surface — the exact defect this
// mechanism exists to prevent. Fail the build (non-zero exit) instead of shipping a silent un-suppression.
const unusedSupp = [...suppressedFp].filter((fp) => !usedSuppressions.has(fp));
if (unusedSupp.length > 0) {
  db.close();
  throw new Error(
    `${unusedSupp.length} suppression(s) matched NO built link — a stale/mis-keyed takedown would silently ` +
      `un-suppress a contested link. Fix or remove the entry (or re-fingerprint after a key rotation). ` +
      `Unmatched fingerprints: ${unusedSupp.map((f) => f.slice(0, 12) + '…').join(', ')}`,
  );
}

// --- integrity + report -------------------------------------------------------------------------
const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const links = one('SELECT COUNT(*) n FROM interest_links').n;
const pub = one("SELECT COUNT(*) n FROM interest_links WHERE status='published'").n;
// Per-interest-class € deduped per ЕИК (money is per-winner, not per-link — see published_contract_value_eur).
// Own map so the value SUMs per (class, ЕИК) while the link COUNT below stays per-link, without a nested
// correlated subquery.
const classValueByClass = new Map(
  q(
    "SELECT interest_class, ROUND(COALESCE(SUM(v),0)) v FROM (SELECT interest_class, eik, MAX(contract_value_eur) v FROM interest_links WHERE status='published' GROUP BY interest_class, eik) GROUP BY interest_class",
  ).map((r) => [r.interest_class, r.v]),
);
const S = {
  persons: one('SELECT COUNT(*) n FROM persons').n,
  declarations: one('SELECT COUNT(*) n FROM declarations').n,
  declared_interests: one('SELECT COUNT(*) n FROM declared_interests').n,
  related_internal: one('SELECT COUNT(*) n FROM related_persons_internal').n,
  interest_links: links,
  published: pub,
  held_for_census: one("SELECT COUNT(*) n FROM interest_links WHERE status='held'").n,
  suppressed: one("SELECT COUNT(*) n FROM interest_links WHERE status='suppressed'").n,
  withdrawn_divested: one("SELECT COUNT(*) n FROM interest_links WHERE status='withdrawn'").n, // E11 expiry
  officials_linked: one('SELECT COUNT(DISTINCT person_id) n FROM interest_links').n,
  officials_managing: one(
    "SELECT COUNT(DISTINCT person_id) n FROM interest_links WHERE relation LIKE '%manages%'",
  ).n,
  contemporaneous: one('SELECT COUNT(*) n FROM interest_links WHERE contemporaneous=1').n,
  own_institution_exact: one("SELECT COUNT(*) n FROM interest_links WHERE own_institution='exact'")
    .n,
  own_institution_name_contains: one(
    "SELECT COUNT(*) n FROM interest_links WHERE own_institution='name_contains'",
  ).n,
  own_institution_locality: one(
    "SELECT COUNT(*) n FROM interest_links WHERE own_institution='locality'",
  ).n,
  // Money is a COMPANY-level quantity keyed on ЕИК, not per-link: contract_value_eur is the winner's total,
  // identical on every link to that ЕИК. Two DIFFERENT officials on one winner yield two links (the redundant-
  // family collapse only merges a SAME official's own + relative stake), so a plain SUM(contract_value_eur)
  // over links double-counts that winner once per extra official — the same defect fixed in the UI headline
  // (conflicts.ts conflictHeadline, #226). Dedup per ЕИК via MAX (exact, since it is constant within a ЕИК)
  // before summing; COUNT/COUNT(DISTINCT person) stay per-link/per-official.
  published_contract_value_eur: Math.round(
    one(
      "SELECT COALESCE(SUM(v),0) v FROM (SELECT MAX(contract_value_eur) v FROM interest_links WHERE status='published' GROUP BY eik)",
    ).v,
  ),
  // headline conflict number = PRIVATE ownership only (ADR-0019); ex-officio state boards excluded
  published_private_ownership_links: one(
    "SELECT COUNT(*) n FROM interest_links WHERE status='published' AND interest_class='private_ownership'",
  ).n,
  published_private_ownership_value_eur: Math.round(
    one(
      "SELECT COALESCE(SUM(v),0) v FROM (SELECT MAX(contract_value_eur) v FROM interest_links WHERE status='published' AND interest_class='private_ownership' GROUP BY eik)",
    ).v,
  ),
  // family (close-relative) ownership — now published on the named surface identically to self stakes
  // (ADR-0032, superseding ADR-0030); the relative's name is never stored/shown, the relation never asserted.
  published_family_ownership_links: one(
    "SELECT COUNT(*) n FROM interest_links WHERE status='published' AND interest_class='family_ownership'",
  ).n,
  published_family_ownership_value_eur: Math.round(
    one(
      "SELECT COALESCE(SUM(v),0) v FROM (SELECT MAX(contract_value_eur) v FROM interest_links WHERE status='published' AND interest_class='family_ownership' GROUP BY eik)",
    ).v,
  ),
  family_officials: one(
    "SELECT COUNT(DISTINCT person_id) n FROM interest_links WHERE interest_class='family_ownership'",
  ).n,
  // §2 ал.3 ПЗР canary (rail #3): material family holdings by source declaration template — must be 100% 'assets'.
  family_material_by_source_template: Object.fromEntries(familyMaterialByTemplate),
  // links per-link, value_eur deduped per ЕИК (classValueByClass, computed above).
  published_by_interest_class: Object.fromEntries(
    q(
      "SELECT interest_class, COUNT(*) n FROM interest_links WHERE status='published' GROUP BY interest_class",
    ).map((r) => [
      r.interest_class,
      { links: r.n, value_eur: classValueByClass.get(r.interest_class) ?? 0 },
    ]),
  ),
  // interest_link_authorities.value_eur is per (link, authority) but company-level: two officials on one ЕИК
  // carry the SAME value for the SAME authority. Dedup per (ЕИК, authority) via MAX before summing.
  published_own_institution_value_eur: Math.round(
    one(
      "SELECT COALESCE(SUM(v),0) v FROM (SELECT MAX(ila.value_eur) v FROM interest_link_authorities ila JOIN interest_links il ON il.link_key=ila.link_key WHERE il.status='published' AND ila.own='exact' GROUP BY il.eik, ila.authority_id)",
    ).v,
  ),
  // strongest signal: material ownership (self OR family) whose company sold to the official's OWN institution
  published_own_institution_links: one(
    "SELECT COUNT(*) n FROM interest_links WHERE status='published' AND own_institution='exact' AND interest_class IN ('private_ownership','family_ownership')",
  ).n,
  by_match_method: Object.fromEntries(
    q('SELECT match_method, COUNT(*) n FROM interest_links GROUP BY match_method').map((r) => [
      r.match_method,
      r.n,
    ]),
  ),
  ambiguous_name_keys: ambiguousKeys.length,
  ambiguous_name_key_examples: ambiguousKeys,
  noMatch,
  quarantined,
  immaterialFamilySkipped: immaterialFamily,
  unknownHolderSkipped: unknownHolder,
  namelessInstitutionSkipped: namelessInstitution,
  namelessPersonSkipped: namelessPerson,
};
console.log(JSON.stringify(S, null, 2));

const examples = q(
  'SELECT p.name official, d.institution, b.name winner, il.eik, il.relation, il.publish_tier, il.status, ' +
    'il.contemporaneous, il.own_institution, il.contract_count, ROUND(il.contract_value_eur) value_eur, ' +
    "il.first_contract_year||'–'||il.last_contract_year contract_years, " +
    "(SELECT GROUP_CONCAT(authority_name,' | ') FROM interest_link_authorities WHERE link_key=il.link_key AND own='exact') own_bought_by " +
    'FROM interest_links il JOIN persons p ON p.id=il.person_id JOIN bidders b ON b.id=il.bidder_id ' +
    'JOIN declarations d ON d.person_id=il.person_id ' +
    "GROUP BY il.id ORDER BY (il.own_institution='exact')*4+(il.relation LIKE '%manages%')*2+il.contemporaneous+(il.status='published') DESC, il.contract_value_eur DESC LIMIT 25",
);
const md = [
  '# Свързани лица — resolved domain (Phase 1 load)',
  '',
  `_matcher ${MATCHER_VERSION}; DB ${path.relative(ROOT, DB)}_`,
  '',
  '## Persisted domain',
  '```json',
  JSON.stringify(S, null, 1),
  '```',
  '',
  '## Strongest published leads',
  '```json',
  JSON.stringify(examples, null, 1),
  '```',
  '',
].join('\n');
fs.writeFileSync(REPORT, md);
console.log(
  ambiguousKeys.length
    ? `\nℹ ${ambiguousKeys.length} ambiguous name keys (>1 valid ЕИК) — quarantined, never published (telemetry, not a gate; ADR-0027)`
    : '\nℹ 0 ambiguous name keys',
);
// §2 ал.3 rail-3 tripwire: any material family holding from a non-'assets' template is a relative's stake
// pulled from a non-public source — investigate before ship. Telemetry (ADR-0027 stance), not a hard gate.
const familyLeak = [...familyMaterialByTemplate].filter(([t]) => t !== 'assets');
console.log(
  familyLeak.length
    ? `⚠ §2 ал.3 CANARY: ${familyLeak.length} family holding template(s) ≠ 'assets' — non-public source: ${familyLeak
        .map(([t, n]) => `${t}:${n}`)
        .join(', ')} (rail #3, ADR-0032)`
    : "✓ §2 ал.3 canary: all material family holdings sourced from 'assets' declarations (rail #3, ADR-0032)",
);
console.log(`report → ${REPORT}`);
db.close();
// No exit code is tied to ambiguity — it is expected, quarantined, and safe. The over-merge libel proof
// is the labelled company-name-key.test.ts; the loader fails only on an actual exception.
