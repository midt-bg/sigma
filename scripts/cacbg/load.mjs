// Phase 1 — productionized loader/resolver. Reads the extracted staging (holdings.jsonl / related.jsonl),
// resolves each declared interest to a winning bidder's ЕИК via the ONE production normalizer, and
// persists the свързани-лица domain (persons / declarations / declared_interests / interest_links /
// related_persons_internal) into the target SQLite/D1 per migration 0002. Idempotent: it rebuilds the
// domain tables from staging each run (link_suppressions — human-curated — persist).
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB = process.env.CACBG_DB || path.join(ROOT, 'data/work/backfill.sqlite');
const STAGING = process.env.CACBG_STAGING || path.join(ROOT, 'scratch/cacbg/staging');
const MIGRATION = path.join(ROOT, 'packages/db/migrations/0002_related_persons_foundation.sql');
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
// Full idempotent rebuild that also picks up schema changes: preserve human-curated suppressions,
// drop the CACBG tables (children first — FK-safe), re-apply migration 0002, restore suppressions.
let savedSuppressions = [];
if (
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='link_suppressions'").get()
) {
  savedSuppressions = db
    .prepare('SELECT link_key,reason,suppressed_by,suppressed_at FROM link_suppressions')
    .all();
}
for (const t of [
  'interest_link_authorities',
  'interest_links',
  'declared_interests',
  'related_persons_internal',
  'declarations',
  'persons',
  'link_suppressions',
])
  db.exec(`DROP TABLE IF EXISTS ${t}`);
db.exec(fs.readFileSync(MIGRATION, 'utf8'));
const insSupp = db.prepare(
  'INSERT INTO link_suppressions(link_key,reason,suppressed_by,suppressed_at) VALUES(?,?,?,?)',
);
for (const s of savedSuppressions)
  insSupp.run(s.link_key, s.reason, s.suppressed_by, s.suppressed_at);
const suppressed = new Set(savedSuppressions.map((s) => s.link_key));

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
const personId = (name, institution) =>
  `person:${companyNameKey(name)}|${companyNameKey(institution ?? '')}`;
// Financial-interest kinds (a genuine stake), as opposed to management-only or listed securities.
const OWN_KINDS = new Set(['shares', 'participation', 'sole_trader']);
const agg = new Map();
// `${pid}|${scope}` → latest year that scope filed a MATERIAL ownership holding (E11 divestment horizon).
const ownMaxByScope = new Map();
let diN = 0,
  noMatch = 0,
  quarantined = 0,
  immaterialFamily = 0,
  namelessPerson = 0;

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
  // E11 divestment horizon (per person+scope) — advance BEFORE resolution, over EVERY material ownership
  // filing, not only winner-resolved ones. Most declared holdings are ordinary non-winner companies; if the
  // horizon only advanced on resolved holdings, an official who divested a winner-stake and kept filing
  // (listing only non-winner companies) would never advance it, so the stale winner link would keep
  // asserting a CURRENT stake — a false present-tense claim. `divested` below compares each link's own last
  // year against this scope-wide horizon, so it must see the official's latest filing regardless of match.
  if (material) {
    const hy = yr(h.year);
    if (Number.isFinite(hy)) {
      const sk = `${pid}|${scope}`;
      ownMaxByScope.set(sk, Math.max(ownMaxByScope.get(sk) ?? hy, hy));
    }
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
        seats: new Set(),
        institutions: new Set(),
        method: res.method,
      })
      .get(gid);
  if (METHOD_RANK[res.method] > METHOD_RANK[rec.method]) rec.method = res.method; // strongest evidence wins
  rec.kinds.add(h.kind);
  const y = yr(h.year);
  if (Number.isFinite(y)) rec.declYears.add(y);
  // Per-company material ownership years (this resolved winner only) — `recOwnMax` below dates the link to
  // its last declaration. The per-scope horizon (ownMaxByScope) is advanced above, before resolution, so it
  // spans ALL material filings; comparing the two is what detects divestment (§8/E11). Material-ownership
  // only: management filing cadence is unverified (spec §6). Blind spot (documented): a divest-to-ZERO
  // filing produces no holdings row, so the temporal dating is the residual mitigation.
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
  const scopeOwnMax = ownMaxByScope.get(`${rec.pid}|${rec.scope}`) ?? null;
  const divested =
    (relation === 'owns' || relation === 'owns+manages' || relation === 'related') &&
    recOwnMax != null &&
    scopeOwnMax != null &&
    scopeOwnMax > recOwnMax;
  // status must be SELF-DESCRIBING in D1: 'published' means "on the public surface", not merely "passed
  // the tier gate". Only material ownership (self/family) surfaces; ex_officio_board / management_role
  // never do (the served query also filters by interest_class, but that's a query constant — a direct D1
  // reader must not see a non-surfaced official+company row labelled 'published'). Non-surfaced classes
  // that would otherwise publish get 'internal'; suppressed/withdrawn/held still take precedence.
  const surfaces = iClass === 'private_ownership' || iClass === 'family_ownership';
  const status = suppressed.has(linkKey)
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

// --- integrity + report -------------------------------------------------------------------------
const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const links = one('SELECT COUNT(*) n FROM interest_links').n;
const pub = one("SELECT COUNT(*) n FROM interest_links WHERE status='published'").n;
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
  published_contract_value_eur: Math.round(
    one("SELECT COALESCE(SUM(contract_value_eur),0) v FROM interest_links WHERE status='published'")
      .v,
  ),
  // headline conflict number = PRIVATE ownership only (ADR-0019); ex-officio state boards excluded
  published_private_ownership_links: one(
    "SELECT COUNT(*) n FROM interest_links WHERE status='published' AND interest_class='private_ownership'",
  ).n,
  published_private_ownership_value_eur: Math.round(
    one(
      "SELECT COALESCE(SUM(contract_value_eur),0) v FROM interest_links WHERE status='published' AND interest_class='private_ownership'",
    ).v,
  ),
  // family (close-relative) ownership — the previously-discarded half of the map (anonymized surface, ADR-0023)
  published_family_ownership_links: one(
    "SELECT COUNT(*) n FROM interest_links WHERE status='published' AND interest_class='family_ownership'",
  ).n,
  published_family_ownership_value_eur: Math.round(
    one(
      "SELECT COALESCE(SUM(contract_value_eur),0) v FROM interest_links WHERE status='published' AND interest_class='family_ownership'",
    ).v,
  ),
  family_officials: one(
    "SELECT COUNT(DISTINCT person_id) n FROM interest_links WHERE interest_class='family_ownership'",
  ).n,
  published_by_interest_class: Object.fromEntries(
    q(
      "SELECT interest_class, COUNT(*) n, ROUND(COALESCE(SUM(contract_value_eur),0)) v FROM interest_links WHERE status='published' GROUP BY interest_class",
    ).map((r) => [r.interest_class, { links: r.n, value_eur: r.v }]),
  ),
  published_own_institution_value_eur: Math.round(
    one(
      "SELECT COALESCE(SUM(value_eur),0) v FROM interest_link_authorities ila JOIN interest_links il ON il.link_key=ila.link_key WHERE il.status='published' AND ila.own='exact'",
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
console.log(`report → ${REPORT}`);
db.close();
// No exit code is tied to ambiguity — it is expected, quarantined, and safe. The over-merge libel proof
// is the labelled company-name-key.test.ts; the loader fails only on an actual exception.
