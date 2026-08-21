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
// nameDistinctiveness is deliberately NOT imported: the evidence ladder replaced it in the publish
// path (ADR-0033). It survives in classify.mjs for the review queue, not for a publishing decision.
import {
  temporalStatus,
  localityToken,
  closelyHeldForm,
  nameDistinctiveness,
} from './classify.mjs';
import {
  openCache,
  coverage,
  readVerdict,
  splitLinkRecord,
  verdictIsCurrent,
} from '../tr/cache.mjs';
import { TR_DB } from '../tr/paths.mjs';
// evidenceVerdict and reconcileTermination are deliberately NOT imported any more: both need the deed,
// and by the time this pass runs the deed is gone by design (ADR-0037). The crawler calls them; this
// pass reads what they decided.
import { isSealedFact, RULES_VERSION } from '../tr/evidence.mjs';
import { companyCandidates, declaredEiks } from './extract-companies.mjs';
import {
  fingerprint,
  loadCorrections,
  loadSuppressions,
  SUPPRESSION_KEY_VERSION,
} from './suppressions.mjs';
import { canonicalInstitution } from './institutions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB = process.env.CACBG_DB || path.join(ROOT, 'data/work/backfill.sqlite');
const STAGING = process.env.CACBG_STAGING || path.join(ROOT, 'scratch/cacbg/staging');
const MIGRATION = path.join(ROOT, 'packages/db/migrations/0003_related_persons_foundation.sql');
// 0006 attaches the Trade Register evidence seal (#279, ADR-0033). Applied here as well as 0003
// because this loader rebuilds the CACBG tables from the migrations on every run — a seal table
// missing from the work DB would make every evidence write fail at ship time instead of at load.
const MIGRATION_EVIDENCE = path.join(
  ROOT,
  'packages/db/migrations/0009_interest_link_evidence.sql',
);
const REPORT = path.join(STAGING, 'findings.md');
// Bumped for #279: classify-2 (КДА added to the joint-stock bar) + tr-1 (identity now rests on a
// Trade Register fact, not on name distinctiveness). RULES_VERSION versions the EVIDENCE rules
// separately — §8's monotonicity gate keys on that one, not on this.
const MATCHER_VERSION = 'cnk-1+classify-2+tr-1';
const TR_CACHE_DB = process.env.TR_CACHE_DB || TR_DB;
// A deliberate, logged override for the coverage gate below. Without it a single permanently
// unreachable ЕИК would deadlock the pipeline forever; with it, the operator states that they know.
const ALLOW_PARTIAL_TR = process.argv.includes('--allow-partial-tr');
// Bootstrap mode: write the crawl's input list and stop, successfully. The decision run and the register
// crawl now share one job (they must — the raw deeds hold third-party names and cannot travel between
// runners), and that job has to be able to start from nothing: the list is derived from the resolved
// corpus, so only this script can produce it, but the full run refuses without the very cache the list
// is used to fill. Ignoring the refusal's exit code instead would erase the difference between „no cache
// yet" and „this run is broken".
//
// POINT THIS AT A SCRATCH COPY OF THE WORK DB. It is not a read-only pass: reaching the candidate list
// means rebuilding the corpus tables, so it drops and repopulates persons/declarations/declared_interests
// and leaves interest_links EMPTY. Empty is the safe end state (the ship floor refuses it, and no link
// can be published without evidence it never gathered), but it is not the state a subsequent real run
// should inherit. The one thing it must never touch either way is the monotonicity snapshot — see below.
const EMIT_CANDIDATES_ONLY = process.argv.includes('--emit-candidates');
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

// Bootstrap mode works on a THROWAWAY COPY, and that is not a convenience — it is the correctness of the
// monotonicity gate. Reaching the candidate list means rebuilding the corpus tables, which drops
// interest_links; the pass itself never publishes, so it would leave the table EMPTY. The next real run
// would then read that empty table as its prior-published set, write an empty snapshot, and the gate —
// whose only job is to notice a published claim disappearing — would pass unconditionally, for ever.
// Copying here rather than asking the caller to do it keeps the flag safe wherever it is invoked from.
const WORK_DB = EMIT_CANDIDATES_ONLY ? `${DB}.bootstrap` : DB;
if (EMIT_CANDIDATES_ONLY) {
  for (const suffix of ['', '-wal', '-shm']) {
    // -wal/-shm may legitimately be absent (a cleanly closed DB has neither); anything else must surface.
    try {
      fs.copyFileSync(`${DB}${suffix}`, `${WORK_DB}${suffix}`);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}
const db = new DatabaseSync(WORK_DB);
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
// Export the CURRENT published surface before anything is dropped — ADR-0033 decision 6.
//
// The rebuild below is total, so the previous run's published set exists only in this instant. The
// audit compares against this file and hard-fails on a link that was published last run and is not
// published now under an UNCHANGED rules_version: nothing licensed that removal, so it is a silent
// recall regression. rules_version travels per key, because a link that vanished under a rules BUMP is
// an intentional removal and must degrade to a printed diff instead.
//
// Held and withdrawn links are deliberately excluded: they were never a public claim, so their absence
// next run is not a regression. On a first run the tables do not exist yet and the export is an empty
// set — written, not skipped, so a missing file means „the loader never ran", not „nothing published".
const priorPublished = (() => {
  try {
    return db
      .prepare(
        `SELECT il.link_key AS link_key, e.rules_version AS rules_version
           FROM interest_links il
           LEFT JOIN interest_link_evidence e ON e.link_key = il.link_key
          WHERE il.status = 'published'`,
      )
      .all()
      .map((r) => ({ link_key: r.link_key, rules_version: r.rules_version ?? RULES_VERSION }));
  } catch (e) {
    // A first run: interest_links does not exist yet. Any OTHER failure must surface — swallowing it
    // would turn a broken export into a permanently silent gate.
    if (!/no such table/i.test(e.message)) throw e;
    return [];
  }
})();
// Decision 6's SECOND sanctioned removal: „a correction of wrong input". A link whose input was wrong
// should never have been published, but correcting the input UNBUILDS it — so a suppression on it
// would match no built link and trip the B3 gate above, while doing nothing leaves a permanent hard
// finding. The acknowledgement is therefore recorded here, against the set the gate actually compares:
// each prior-published key whose fingerprint is listed is exported flagged, and audit.mjs reads the
// flag as a declared removal. Fingerprinted for ADR-0031's reason — `pid|eik` in git would record which
// named official was tied to which company for ever.
const CORRECTIONS_LIST =
  process.env.CACBG_CORRECTIONS_LIST || path.join(ROOT, 'scripts/cacbg/link-corrections.jsonl');
const correctedFp = new Set(
  loadCorrections(CORRECTIONS_LIST, SUPP_SALT, SUPPRESSION_KEY_VERSION).map((e) => e.fp),
);
const usedCorrections = new Set();
const snapshot = priorPublished.map((p) => {
  if (correctedFp.size === 0) return p;
  const fp = fingerprint(p.link_key, SUPP_SALT);
  if (!correctedFp.has(fp)) return p;
  usedCorrections.add(fp);
  return { ...p, corrected: true };
});
// The B3 rail, mirrored — and it matters MORE here. A stale suppression silently un-suppresses; a
// stale acknowledgement silently pre-clears a FUTURE disappearance of that same link, which is exactly
// the regression the gate exists to catch, with nobody having decided it. An acknowledgement is
// one-shot by construction: once the corrected link stops being published it also stops appearing in
// the prior set, so the entry must be deleted from the list in the same change that lands the fix.
if (!EMIT_CANDIDATES_ONLY) {
  const unusedCorr = [...correctedFp].filter((fp) => !usedCorrections.has(fp));
  if (unusedCorr.length > 0) {
    db.close();
    throw new Error(
      `${unusedCorr.length} correction(s) matched NO previously published link — a stale acknowledgement ` +
        `would clear a future disappearance of that link, which is the regression this gate exists to ` +
        `catch. Delete the entry once its fix has shipped (an acknowledgement is one-shot). ` +
        `Unmatched fingerprints: ${unusedCorr.map((f) => f.slice(0, 12) + '…').join(', ')}`,
    );
  }
}
// Not written by the bootstrap pass, which works on a throwaway copy and has no business restating what
// the real run is about to record.
//
// tmp + rename, not a bare write: a crash mid-write leaves a truncated file, and audit.mjs deliberately
// does NOT swallow a parse failure here (only ENOENT is a legitimate first run). A torn snapshot would
// therefore wedge every subsequent audit until a human cleared the file by hand. The raw deeds already
// land this way; the gate's own input deserves the same.
if (!EMIT_CANDIDATES_ONLY) {
  const snapPath = path.join(STAGING, 'published-snapshot.json');
  const snapTmp = `${snapPath}.tmp`;
  fs.writeFileSync(snapTmp, JSON.stringify(snapshot, null, 2) + '\n');
  fs.renameSync(snapTmp, snapPath);
}

// Full idempotent rebuild that also picks up schema changes: drop the CACBG tables (children first —
// FK-safe) and re-apply the migration. Nothing to preserve — suppressions are external now.
for (const t of [
  // FIRST: interest_link_evidence references interest_links, so it must go before its parent.
  'interest_link_evidence',
  'interest_link_authorities',
  'interest_links',
  'declared_interests',
  'related_persons_internal',
  'declarations',
  'persons',
])
  db.exec(`DROP TABLE IF EXISTS ${t}`);
db.exec(fs.readFileSync(MIGRATION, 'utf8'));
db.exec(fs.readFileSync(MIGRATION_EVIDENCE, 'utf8'));
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
//
// A filing whose <year> is unreadable falls back to its FOLDER year (#279 §1.3). Dropping the record
// instead — the previous behaviour — is not the fail-safe it resembles: an undated filing that vanishes
// never advances the horizon, so `divested` stays false and a stake the official has since SOLD keeps
// naming them on the public surface. That is a stale claim about a real person, which is the failure this
// surface can least afford. The folder year is an APPROXIMATION — it is the publication year and runs
// ahead of the declared year (migration 0003) — so it can advance the horizon by up to a year early. That
// errs toward WITHDRAWING a claim we are no longer sure of, which is the safe direction here.
//
// A filing datable by NEITHER field is still ignored: the fallback dates a filing, it does not invent one.
const filingMaxByPersonType = new Map();
let filingFolderDated = 0,
  filingUndatable = 0;
for (const f of readJsonl(path.join(STAGING, 'filings.jsonl'))) {
  if (!isMatchableKey(companyNameKey(f.person))) continue;
  let fy = yr(f.year);
  if (!Number.isFinite(fy)) {
    fy = yr(f.folder);
    if (!Number.isFinite(fy)) {
      // Counted, not silently dropped. A horizon we failed to advance is invisible in the output — the
      // link simply stays up — so without this the only symptom of a corpus-wide date regression would be
      // a surface that quietly stopped withdrawing anything.
      filingUndatable++;
      continue;
    }
    filingFolderDated++;
  }
  const k = `${personId(f.person, f.institution)}|${f.template ?? ''}`;
  filingMaxByPersonType.set(k, Math.max(filingMaxByPersonType.get(k) ?? fy, fy));
}
if (filingFolderDated > 0 || filingUndatable > 0) {
  console.log(
    `  filings: ${filingFolderDated} dated by FOLDER (unreadable <year>), ${filingUndatable} undatable (ignored — no horizon)`,
  );
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
// THE WRITER of contract_count / contract_value_eur. Its join shape (contracts→tenders→authorities→
// bidders) is mirrored by CONTRACT_JOIN in packages/db/src/queries/related-persons.ts, so that the
// read-time subset can never exceed what was stored. `authorities` here IS projected (the per-authority
// breakdown needs the name), unlike on the read side where it looks dead — that asymmetry is why the two
// have to be pinned to each other rather than reasoned about separately. related-persons-sql.test.ts
// asserts they agree; change one only by changing both, and re-baseline ADR-0033 §10 when you do.
const contractStmt = db.prepare(
  "SELECT strftime('%Y', c.signed_at) yr, a.id auth_id, a.name authority, c.amount_eur eur FROM contracts c JOIN tenders t ON t.id=c.tender_id JOIN authorities a ON a.id=t.authority_id JOIN bidders b ON b.id=c.bidder_id WHERE b.eik_normalized=?",
);
const insLink = db.prepare(
  'INSERT INTO interest_links(id,link_key,person_id,bidder_id,eik,entity_key,match_method,matcher_version,publish_tier,relation,interest_class,contemporaneous,own_institution,evidence_count,first_declared_year,last_declared_year,contract_count,contract_value_eur,first_contract_year,last_contract_year,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
);
const insILA = db.prepare(
  'INSERT OR IGNORE INTO interest_link_authorities(link_key,authority_id,authority_name,contract_count,value_eur,own) VALUES(?,?,?,?,?,?)',
);
// The evidence seal (#279 §8, migration 0006). Written for EVERY link, not only published ones — the
// seals on held and withdrawn links are what let the review queue explain itself. `matched_fact` is a
// closed vocabulary and must NEVER carry a name; the audit enforces that with a pattern check.
const insEvidence = db.prepare(
  'INSERT OR REPLACE INTO interest_link_evidence(link_key,evidence_kind,registry_role,matched_fact,entry_number,entry_date,lookup_date,rules_version,live_status) VALUES(?,?,?,?,?,?,?,?,?)',
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
// ── Trade Register evidence: the candidate set, the fail-closed gate, and the deed reader ─────────
// Identity now rests on a checkable registry fact rather than on the shape of the declared name
// (#279, ADR-0033). Two consequences the loader has to enforce, both fail-closed:
//
//   1. NO cache ⇒ throw. Publishing without evidence is precisely what this change abolishes.
//   2. PARTIAL cache ⇒ throw. This is the silent one. An 80%-restored cache yields roughly 80
//      published links, which is ABOVE ship-related-persons.mjs's floor of 50 — so it would sail
//      through that guard, ship a decimated surface, and wipe the rest of the live links.
//
// The candidate set is every resolved ЕИК across ALL aggregates, not just the ones that end up
// published: a link held for want of evidence still needs its deed to say so.
const candidateEiks = [...new Set([...agg.values()].map((r) => r.eik))].sort();
fs.writeFileSync(path.join(STAGING, 'candidate-eiks.txt'), candidateEiks.join('\n') + '\n');

/**
 * The link identity and the declaration side of its evidence question — the crawler's input under
 * ADR-0037, and the decision pass's cache key. Returns null for an aggregate that forms no link.
 *
 * ONE builder, used by both passes on purpose. The verdict cache is keyed on a hash of this object,
 * so an emit pass and a decision pass that built it even slightly differently would miss every cache
 * entry and re-crawl the whole register — the failure would be a 5-hour bill, not an error.
 *
 * Carries the DECLARANT's name: a public official, published by the source register and by our own
 * surface. Never a relative (ADR-0032 does not name them) and never anyone from a deed.
 */
function linkRecordFor(rec) {
  // The same skip the decision loop applies: an immaterial self record is census, not a link. Emitting
  // it would send the crawler after a deed no decision ever asks about.
  if (rec.scope === 'self' && !rec.hasMaterialOwn && !rec.kinds.has('management')) return null;
  const declYears = [...rec.declYears];
  return {
    linkKey: rec.scope === 'family' ? `${rec.pid}|${rec.eik}|family` : `${rec.pid}|${rec.eik}`,
    eik: rec.eik,
    declarantName: rec.person,
    declaredSeats: [...rec.seats],
    declaredEik: rec.method === 'declared_eik',
    firstDeclaredYear: declYears.length ? Math.min(...declYears) : null,
    scope: rec.scope,
    nameGloballyUnique: nameGloballyUnique(rec.key),
    companyNameDistinctive: nameDistinctiveness(rec.key) === 'distinctive',
  };
}
const candidateLinks = [...agg.values()].map(linkRecordFor).filter(Boolean);
fs.writeFileSync(
  path.join(STAGING, 'candidate-links.jsonl'),
  candidateLinks.map((l) => JSON.stringify(l)).join('\n') + '\n',
);

if (EMIT_CANDIDATES_ONLY) {
  // Stop BEFORE the TR gate and before anything is written to the domain. A bootstrap pass that built
  // links would leave a surface resting on no evidence at all, and a failure between this pass and the
  // real one would leave that surface sitting in the work DB, shippable.
  console.log(
    `${candidateEiks.length} candidate ЕИК / ${candidateLinks.length} link(s) written for the ` +
      `crawler; stopping (--emit-candidates)`,
  );
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${WORK_DB}${suffix}`, { force: true }); // the copy has served its purpose
  process.exit(0);
}

if (!fs.existsSync(TR_CACHE_DB)) {
  db.close();
  throw new Error(
    `REFUSE TO LOAD: no Trade Register cache at ${TR_CACHE_DB}. Every publishing decision now rests ` +
      `on a registry fact (ADR-0033); without the cache there is no evidence to rest on. Run ` +
      `scripts/tr/fetch-deeds.mjs --links-file ${path.join(STAGING, 'candidate-links.jsonl')} first.`,
  );
}
const trCache = openCache(TR_CACHE_DB);
const trCoverage = coverage(trCache, candidateEiks);
console.log(
  `TR deeds: ${trCoverage.covered}/${trCoverage.wanted} ЕИК covered ` +
    `(fetched ${trCoverage.fetched}, outside ТР ${trCoverage.outsideTr}, missing ${trCoverage.missing})`,
);

// ── the incremental gate (ADR-0037) ──────────────────────────────────────────────────────────────
// The old rule refused on a single missing ЕИК. That was right while a crawl was all-or-nothing: a
// partial cache publishes a decimated surface, clears the ship floor of 50, and wipes the rest of the
// live links. It is wrong now that a crawl legitimately makes partial progress across runs — under the
// measured limiter (ADR-0036) an all-or-nothing gate never opens at all.
//
// The protection does not go away, it moves to where it already existed: §8's monotonicity gate, whose
// entire job is noticing a published claim that disappeared. A link that loses its evidence stops being
// published and audit.mjs hard-fails on exactly that, with the rules_version escape for a deliberate
// bump. Two gates for one duty was the redundancy; the weaker one goes.
//
// What stays is a floor on how much of the surface may rest on no verdict at all — and it applies to
// EVERY run, not only a first one. Keying it on „is there a prior published set" left a 95% floor that
// a single leftover published row switched off entirely: monotonicity would then protect that one row
// while a decimated surface shipped past the ship floor of 50 beneath it.
//
// Always-on is affordable because the currency test below deliberately ignores AGE — a verdict stops
// being current only when the rules move or the declaration changes. Steady state is therefore ~100%,
// and the two ways to fall below it are the two where refusing is right: a cold start, and a rules
// bump whose re-crawl has not caught up (publishing then would mean publishing on a ladder this code
// no longer speaks). `--allow-partial-tr` remains the stated override for a smaller surface.
const VERDICT_FLOOR = 0.95;
// `verdictIsCurrent`, not a hand-rolled copy. There were two copies of this predicate here and both
// could be deleted with every test still green — on the LAST fail-closed check before publishing a
// claim about a named person. The duplication is why the cache-side test could not kill the loader-side
// mutation; one definition means one thing to test.
//
// `maxAgeDays` is deliberately omitted: age governs what the CRAWLER re-asks, not what may be
// published. Withholding on age would delete a true claim the moment a rate limit delayed its refresh,
// and `purgeExpired` already bounds how stale a stored lookup can get.
const verdictCurrency = { rulesVersion: RULES_VERSION };
const linksAwaitingVerdict = candidateLinks.filter(
  (l) => !verdictIsCurrent(readVerdict(trCache, l.linkKey), splitLinkRecord(l), verdictCurrency),
);
const verdictsCurrent = candidateLinks.length - linksAwaitingVerdict.length;
const verdictRatio = candidateLinks.length === 0 ? 1 : verdictsCurrent / candidateLinks.length;
console.log(
  `TR verdicts: ${verdictsCurrent}/${candidateLinks.length} current ` +
    `(${(verdictRatio * 100).toFixed(1)}%)`,
);
if (linksAwaitingVerdict.length) {
  // ЕИК only, never link_key: the key embeds the official's name, and a name has no business in a CI
  // log (ADR-0033 decision 5). The ЕИК is what the operator needs to re-run the crawler against.
  const eiks = [...new Set(linksAwaitingVerdict.map((l) => l.eik))].sort();
  console.log(
    `  awaiting a registry verdict: ${eiks.slice(0, 20).join(', ')}` +
      (eiks.length > 20 ? ` … and ${eiks.length - 20} more` : ''),
  );
}
if (verdictRatio < VERDICT_FLOOR && !ALLOW_PARTIAL_TR) {
  trCache.close();
  db.close();
  throw new Error(
    `REFUSE TO LOAD: only ${verdictsCurrent} of ${candidateLinks.length} link(s) carry a current ` +
      `registry verdict (${(verdictRatio * 100).toFixed(1)}% < ${VERDICT_FLOOR * 100}%). Publishing ` +
      `now would rest the surface on evidence most of it does not have. Re-run the crawler until the ` +
      `cache fills — it resumes — or pass --allow-partial-tr to state that a smaller surface is ` +
      `intended.` +
      `\nAwaiting a verdict (ЕИК): ${[...new Set(linksAwaitingVerdict.map((l) => l.eik))]
        .sort()
        .slice(0, 20)
        .join(', ')}`,
  );
}

// The lookup date sealed on every link: when the evidence was gathered, not when it was interpreted.
// It is the freshness bound the methodology page has to state, so it comes from the cache rather than
// from `now` — a re-run over an unchanged cache must not make the evidence look fresher than it is.
// Fallback only, for a link with no verdict of its own to date. Once the crawl is incremental
// (ADR-0037) a single global MAX would stamp this run's date onto a decision reached weeks ago and
// overstate the freshness the methodology page promises — so the sealed date is per link, taken from
// the verdict's own decided_at, and this is what is left when there is no verdict at all.
const trLookupFallback = (() => {
  const row = trCache.prepare('SELECT MAX(fetched_at) m FROM deeds').get();
  return row?.m ? String(row.m).slice(0, 10) : new Date().toISOString().slice(0, 10);
})();

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
  // ── the evidence ladder replaces the publish tiers (ADR-0033 decision 1) ────────────────────────
  // rec.seats is keyed on `pid|eik|scope`, so it already holds ONLY the seats this person declared for
  // THIS company — which is what #279 §5 rung 3 requires: 4.9% of company-name keys carry more than one
  // distinct declared seat, so a company-only key would let one person's seat confirm another's link.

  // A declarant-provided ЕИК is the national unique identifier (ЗТРРЮЛНЦ) — it resolves the winner
  // deterministically even behind a generic or winner-colliding name, so a declared_eik match publishes
  // on its own basis (A_eik), never held for name-genericness. This is at least as certain as the seat
  // proof that rescues an otherwise-generic name (A_seat) — the ЕИК IS the identity, not a heuristic.
  // Name-only methods (exact_name_key / extracted_name) still ride the distinctiveness/seat gate below:
  // a globally non-unique winner name (e.g. „Водоснабдяване и канализация ЕАД" → 2 valid ЕИК in different
  // towns) can never be name-distinctive, so it publishes only if the declared SEAT disambiguates, else held.
  // The filters that can only WITHHOLD are retained as an AND-gate on the weakest rung only
  // (ADR-0033 decision 2): a nationally shared company name cannot ride „Потвърдено". The stronger
  // „Документ" rung is deliberately not gated — the register named this person in THIS company, which
  // makes the name key moot. Near-zero recall cost, and it preserves ADR-0017's outcome.
  // ADR-0017 carried forward, and NARROWED to what it actually held: a name backing more than one valid
  // ЕИК cannot support a name-derived identity claim. It gates the SEAT leg of rung 3 only — never the
  // declared-ЕИК leg (ADR-0028: the ЕИК is the identity), and never rung 2 (the register named this
  // person in THIS company). nameDistinctiveness is deliberately NOT part of this gate: the seat rung
  // exists precisely to rescue a generic name, so requiring distinctiveness would empty it.
  // „Неизвестна" — the withholding verdict, used for every way of ending up with no usable evidence.
  const noEvidence = () => ({
    kind: 'unknown',
    publishable: false,
    registryRole: null,
    matchedFact: null,
    entryNumber: null,
    entryDate: null,
    rulesVersion: RULES_VERSION,
  });
  // With --allow-partial-tr the operator has accepted an incomplete cache. An uncached ЕИК then yields
  // no evidence at all, which is „Неизвестна" — held. It must never be read as a reason to publish.
  // The decision was reached by the crawler, beside the deed it rests on (ADR-0037). This pass reads
  // it; it never re-derives one, because the deed it would need is deliberately gone by now.
  //
  // A verdict is usable only if it answers TODAY's question: same rules version, same declaration
  // inputs. Age is deliberately NOT a condition here — `purgeExpired` bounds how stale a stored lookup
  // can get, and the lookup date travels onto the link so the reader sees it. Withholding on age would
  // instead delete a true claim the moment a rate limit delayed its refresh.
  const linkRecord = linkRecordFor(rec);
  const cached = linkRecord ? readVerdict(trCache, linkRecord.linkKey) : null;
  const usable =
    cached != null && verdictIsCurrent(cached, splitLinkRecord(linkRecord), verdictCurrency);
  if (!usable && cached != null) {
    console.error(
      `  ${rec.eik}: verdict is stale (rules or declaration moved) — link held until re-crawled`,
    );
  }
  // „Неизвестна" is the honest answer for a link the crawler has not reached yet: held, never a reason
  // to publish. It is exactly what an uncached ЕИК produced before, so the surface degrades the same
  // way it always did — one link at a time, downward.
  const verdict = usable
    ? {
        kind: cached.kind,
        publishable: cached.publishable,
        registryRole: cached.registryRole,
        matchedFact: cached.matchedFact,
        entryNumber: cached.entryNumber,
        entryDate: cached.entryDate,
        rulesVersion: cached.rulesVersion,
      }
    : noEvidence();
  const tier = verdict.kind;
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
  // §7: „terminated" is an inference from SILENCE, and its commonest cause is a finished mandate, not a
  // sale. Before ADR-0021 E11's withdrawal takes effect, a terminated OWN stake is reconciled against the
  // live deed: a person still registered as an owner has not divested. Family stakes are never reconciled
  // — the registered owner there is the relative, whose name we neither store nor check.
  // PHASE 1 uses only `terminated`; the „и към днешна дата" label is computed and deliberately not
  // rendered (ADR-0033 decision 4 — it asserts a present tense behind an LIA addendum).
  // Read from the verdict, not recomputed: the deed it needs is deliberately gone by now (ADR-0037).
  // Without a usable verdict there is nothing to reconcile against, and the honest fallback is the
  // unreconciled `divested` — the same answer the old code gave for an uncached ЕИК.
  const recon =
    divested && rec.scope === 'self' && usable && cached.reconTerminated != null
      ? { terminated: cached.reconTerminated, label: cached.reconLabel }
      : { terminated: divested, label: null };
  const terminatedEffective = recon.terminated;

  // Order matters and differs from the old ladder: `internal` is now decided BEFORE `published`, so a
  // non-surfaced class (ex-officio board, management-only, zero-contract) can never land in `held`.
  // `held` is the REVIEW QUEUE, and its population is exactly the evidence rungs that withhold —
  // bar_joint_stock, unknown and outside_tr.
  const status = isSuppressed(linkKey)
    ? 'suppressed'
    : verdict.kind === 'refuted'
      ? 'withdrawn' // §5.4 — own stakes only; evidence.mjs refuses to refute a family stake
      : terminatedEffective
        ? 'withdrawn'
        : !surfaces
          ? 'internal'
          : verdict.publishable
            ? 'published'
            : 'held';
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
  // live_status is RE-DERIVED every run and never treated as part of the permanent seal (ADR-0033 R3):
  // it asserts a present tense whose freshness is bounded by the cache refresh cycle.
  const liveStatus = !terminatedEffective
    ? recon.label === 'owner_today'
      ? 'terminated_owner_still'
      : 'live'
    : recon.label === 'manager_today'
      ? 'terminated_manager_still'
      : 'terminated';
  // Refuse at WRITE time, not only in the post-hoc audit. The audit runs after the whole domain is
  // built; by then the name is already in a table, and a run that dies on a suppressed-by-default axis
  // could ship it. `matched_fact` is the one sealed column derived from a deed's text, so it is the one
  // place a third-party name can reach a served row — the rail belongs where the value is produced.
  if (!isSealedFact(verdict.matchedFact))
    throw new Error(
      `REFUSE TO SEAL: matched_fact for ${linkKey} is outside the closed vocabulary — a name may have ` +
        `leaked out of a deed (#279 §9, ADR-0033 decision 5)`,
    );
  insEvidence.run(
    linkKey,
    verdict.kind,
    verdict.registryRole,
    verdict.matchedFact,
    verdict.entryNumber,
    verdict.entryDate,
    usable ? String(cached.decidedAt).slice(0, 10) : trLookupFallback,
    verdict.rulesVersion,
    liveStatus,
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
  trCache.close();
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
  // Every evidence rung's count, publishing and withholding alike (ADR-0033 decision 1). `publish_tier`
  // IS the verdict kind since #279.
  by_evidence_kind: Object.fromEntries(
    q('SELECT publish_tier, COUNT(*) n FROM interest_links GROUP BY publish_tier').map((r) => [
      r.publish_tier,
      r.n,
    ]),
  ),
  // ADR-0035's residual: links where the register named this person in the resolved company but nothing
  // established that the company is the declared one. This is the number F8's hand-labelled sample reads
  // to decide whether the distinctiveness gate tightens to strict ЕИК/seat corroboration. Reported
  // separately from the map above because it is a DECISION input, not just a tally.
  document_uncorroborated: one(
    "SELECT COUNT(*) n FROM interest_links WHERE publish_tier='document_uncorroborated'",
  ).n,
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
// Both handles, on every path that leaves this file — the verdict-floor refusal above already closes
// the pair, and a cache left open on the other two would be the same intent kept only half the time.
trCache.close();
db.close();
// No exit code is tied to ambiguity — it is expected, quarantined, and safe. The over-merge libel proof
// is the labelled company-name-key.test.ts; the loader fails only on an actual exception.
