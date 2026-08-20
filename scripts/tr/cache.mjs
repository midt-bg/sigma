// The deed cache — resumability, and the PII rail (issue #279, ADR-0033 decision 5).
//
// A registry deed contains third-party personal data: the names of owners and managers who hold no
// public office, and the company's street address. Two rails follow from that, and both live here:
//
//   1. The INDEX stores no name at all — ЕИК, dates, codes, verdicts, and a hash of the body. Names
//      exist only in the raw JSON under git-ignored scratch/, are read only to produce a boolean, and
//      never enter a public table, a response or a log. A hash rather than an excerpt, because an
//      excerpt of a deed IS third-party personal data.
//   2. Nothing may carry a STANDALONE ten-digit run. That is the ЕГН shape, and the check is sound
//      precisely because an ЕИК is 9 or 13 digits — never 10 — so it cannot reject a legitimate
//      identifier. „Standalone" is load-bearing: a 13-digit ЕИК contains ten-digit substrings, so an
//      unanchored match would refuse every клон. ЕГН was absent from every payload examined; this is
//      the rail for the day one leaks.
//
// Resumability is the other job, and it now spans runs rather than just interruptions. The register
// allows ~5 requests per window and the block clears in ~161s (ADR-0036), so a crawl is bounded by
// wall-clock rather than finished in one pass: it must pick up exactly where it stopped without
// re-requesting what it already holds. That is what the verdict rows below are for (ADR-0037).

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeEik } from './paths.mjs';
import { isSealedFact } from './evidence.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deeds (
  eik                  TEXT PRIMARY KEY,
  status               TEXT NOT NULL,     -- fetched | outside_tr_pending | outside_tr
  http_status          INTEGER,
  fetched_at           TEXT NOT NULL,
  raw_path             TEXT,              -- relative to the raw dir; the ONLY place names live
  body_sha256          TEXT,              -- integrity + change detection, never an excerpt
  legal_form_code      INTEGER,
  legal_form_verdict   TEXT,              -- closely_held | joint_stock | unknown  (unknown WITHHOLDS)
  seat_normalized      TEXT,              -- settlement only; never a street address (ADR-0010 item 3)
  seat_entry_date      TEXT,
  latest_own_entry_date TEXT,
  attempts             INTEGER NOT NULL DEFAULT 1,
  outside_reason       TEXT
);
CREATE INDEX IF NOT EXISTS idx_deeds_status ON deeds(status);
-- The decision itself, per (link, ЕИК) — ADR-0037. This is what survives a run boundary while the
-- deed that produced it does not: a role, an entry reference and booleans. link_key is
-- person:<name>|<institution>|<eik>[|family], so it carries the OFFICIAL's name — a person the
-- surface publishes by design — and never the relative's (ADR-0032 never names them) nor any
-- co-owner's. That is strictly less than scratch/cacbg/raw, which already crosses this boundary.
CREATE TABLE IF NOT EXISTS verdicts (
  link_key      TEXT PRIMARY KEY,
  eik           TEXT NOT NULL,
  rules_version TEXT NOT NULL,     -- evidence.mjs RULES_VERSION at decision time
  inputs_hash   TEXT NOT NULL,     -- over the declaration-side arguments; see verdictInputsHash
  kind          TEXT NOT NULL,
  publishable   INTEGER NOT NULL,
  registry_role TEXT,              -- a ROLE ('управител'), never the person holding it
  matched_fact  TEXT,
  entry_number  TEXT,
  entry_date    TEXT,
  short_name    INTEGER NOT NULL DEFAULT 0,
  latin_in_name INTEGER NOT NULL DEFAULT 0,
  -- reconcileTermination's answer, cached for the same reason as the verdict: it too is a question
  -- about the deed (is this declarant still a registered owner?) whose answer is a boolean and a role
  -- label. Without it a divested self stake would fall to deed == null, be read as terminated and get
  -- WITHDRAWN — a silent recall regression rather than a fail-closed hold.
  recon_terminated INTEGER,
  recon_label      TEXT,
  decided_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verdicts_eik ON verdicts(eik);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Columns added to `verdicts` after it first shipped. See openCache. */
const VERDICT_ADDED_COLUMNS = [
  ['recon_terminated', 'INTEGER'],
  ['recon_label', 'TEXT'],
];

/**
 * Can this file be opened and read as our cache? `PRAGMA integrity_check` catches structural damage;
 * the table probe catches a file that is valid sqlite but not this schema.
 */
function cacheIsUsable(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') return false;
    db.prepare('SELECT COUNT(*) FROM deeds').get();
    return true;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* a file too damaged to close is a file we have already refused */
    }
  }
}

/**
 * Open (creating if absent) the cache at `file`. Idempotent — never wipes a HEALTHY existing cache.
 *
 * A corrupt one is a different matter, and it became one the moment this cache started travelling
 * between runs (ADR-0037): a truncated restore would throw here, the workflow's `if: always()` save
 * would then store that same corrupt file under a NEWER key, and every later run would restore it in
 * preference to the good one. Self-perpetuating, with no way out but a human deleting the cache. So an
 * unusable file is moved aside and the run starts empty — losing progress, which is recoverable,
 * rather than the pipeline, which by then is not.
 */
export function openCache(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && !cacheIsUsable(file)) {
    const quarantined = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, quarantined);
    console.error(
      `TR cache at ${file} failed its integrity check — moved to ${quarantined}, starting empty. ` +
        `Progress is lost; the crawl resumes from scratch rather than compounding the damage.`,
    );
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  // CREATE TABLE IF NOT EXISTS is a no-op on an existing cache, and this cache now SURVIVES between
  // runs (ADR-0037) — so a restored older one would meet a query naming a column it does not have.
  // Added idempotently rather than by recreating the table, because recreating it would throw away
  // exactly the progress the cache exists to keep.
  const have = new Set(
    db
      .prepare(`SELECT name FROM pragma_table_info('verdicts')`)
      .all()
      .map((r) => r.name),
  );
  for (const [col, type] of VERDICT_ADDED_COLUMNS) {
    if (!have.has(col)) db.exec(`ALTER TABLE verdicts ADD COLUMN ${col} ${type}`);
  }
  return db;
}

// ── the ЕГН rail ──────────────────────────────────────────────────────────────
// ANCHORED, and that is the whole correctness of the rail. An ЕИК is 9 or 13 digits — never 10 — so
// a ten-digit run cannot be a legitimate identifier here. But that reasoning only holds when the run
// is matched as a WHOLE: an unanchored /\d{10}/ matches INSIDE the 13-digit ЕИК of a клон, and
// rawPath on the fetched path is `<eik>.json`, so every branch office would be refused and the crawl
// would abort on the first one.
const EGN_SHAPE = /(?<!\d)\d{10}(?!\d)/;
/**
 * Refuse any value destined for the index that carries a standalone ten-digit run — the ЕГН shape.
 * Storing one would breach ADR-0010 decision 2 outright.
 */
function assertNoEgnShape(value, field) {
  if (value != null && EGN_SHAPE.test(String(value))) {
    throw new Error(
      `REFUSE TO STORE: ${field} carries a ten-digit run (ЕГН shape) — the index holds no personal data`,
    );
  }
}

// Screened by EXCLUSION, not by an allowlist: a hand-maintained list of text columns is only as
// strong as whoever remembers to extend it, and the next field added would bypass the rail silently.
// Both exemptions are structural, not conveniences:
//   eik         — already shape-validated by safeEik (9 or 13 digits, nothing else).
//   bodySha256  — 64 chars of [0-9a-f]. A standalone ten-digit run occurs in ~7% of sha256 digests
//                 (18% unanchored, both measured), so screening it would refuse roughly one deed in
//                 fourteen for no privacy gain. A digest is not personal data; it exists precisely so
//                 that no deed content reaches the index.
//   inputsHash  — the same object, for the same reason. Exempting it is not a convenience: screened,
//                 it refused ~1 verdict in 14 at random, which is a silent recall hole spread evenly
//                 across the surface rather than a visible failure.
const EGN_EXEMPT = new Set(['eik', 'bodySha256', 'inputsHash']);

/**
 * Record a fetched deed. Replaces on re-fetch so a refresh never duplicates a row.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} d
 */
export function upsertDeed(db, d) {
  const eik = safeEik(d.eik);
  for (const [f, v] of Object.entries(d)) if (!EGN_EXEMPT.has(f)) assertNoEgnShape(v, f);
  db.prepare(
    `INSERT INTO deeds (eik, status, http_status, fetched_at, raw_path, body_sha256,
        legal_form_code, legal_form_verdict, seat_normalized, seat_entry_date,
        latest_own_entry_date, attempts, outside_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(eik) DO UPDATE SET
        status=excluded.status, http_status=excluded.http_status, fetched_at=excluded.fetched_at,
        raw_path=excluded.raw_path, body_sha256=excluded.body_sha256,
        legal_form_code=excluded.legal_form_code, legal_form_verdict=excluded.legal_form_verdict,
        seat_normalized=excluded.seat_normalized, seat_entry_date=excluded.seat_entry_date,
        latest_own_entry_date=excluded.latest_own_entry_date,
        attempts=deeds.attempts + 1, outside_reason=excluded.outside_reason`,
  ).run(
    eik,
    d.status ?? 'fetched',
    d.httpStatus ?? null,
    d.fetchedAt,
    d.rawPath ?? null,
    d.bodySha256 ?? null,
    d.legalFormCode ?? null,
    d.legalFormVerdict ?? null,
    d.seatNormalized ?? null,
    d.seatEntryDate ?? null,
    d.latestOwnEntryDate ?? null,
    d.attempts ?? 1,
    d.outsideReason ?? null,
  );
}

/**
 * Observe an empty-200 „not in the register" answer, and mark it permanent only on the SECOND one.
 *
 * PERMANENT BY INTENT, so the caller must only reach here on a DOCUMENTED positive response — a 429, a
 * 5xx or a timeout is transient and must never be cached as a negative (R6). But the measurement this
 * rests on is „empty on two consecutive requests", and the code used to mark on the first: a single
 * anomalous empty 200 — from an edge, say, of the kind that already answers our 429s with zero bytes —
 * would have become a 30-day negative for a real company.
 *
 * The second observation costs nothing extra in the steady state: a provisional row writes no verdict,
 * so the ЕИК stays pending and the next run re-asks it in place of the refresh it would have spent
 * anyway. Returns whether the mark is now final, so the caller knows whether it may decide the links.
 *
 * `unambiguous` is for a status that says „not here" on its own — a 404 — where a second look adds
 * nothing. The empty body is the case that needs corroboration, because an empty body is also what a
 * misbehaving edge produces.
 */
export function markOutsideTr(db, eik, reason, now = new Date(), { unambiguous = false } = {}) {
  const prior = readDeed(db, eik);
  const confirming =
    unambiguous || prior?.status === 'outside_tr_pending' || prior?.status === 'outside_tr';
  upsertDeed(db, {
    eik,
    status: confirming ? 'outside_tr' : 'outside_tr_pending',
    fetchedAt: now.toISOString(),
    outsideReason: confirming ? reason : `${reason} (awaiting a second observation)`,
  });
  return confirming;
}

/** One row by ЕИК, camelCased, or null. */
export function readDeed(db, eik) {
  const r = db.prepare('SELECT * FROM deeds WHERE eik = ?').get(safeEik(eik));
  if (!r) return null;
  return {
    eik: r.eik,
    status: r.status,
    httpStatus: r.http_status,
    fetchedAt: r.fetched_at,
    rawPath: r.raw_path,
    bodySha256: r.body_sha256,
    legalFormCode: r.legal_form_code,
    legalFormVerdict: r.legal_form_verdict,
    seatNormalized: r.seat_normalized,
    seatEntryDate: r.seat_entry_date,
    latestOwnEntryDate: r.latest_own_entry_date,
    attempts: r.attempts,
    outsideReason: r.outside_reason,
  };
}

// ── verdicts (ADR-0037) ───────────────────────────────────────────────────────

/**
 * The declaration-side arguments of `evidenceVerdict`, in the order they are hashed.
 *
 * DEED-side inputs (`deed`, `outsideTr`) are deliberately absent: they are not what this hash
 * invalidates against. A changed deed is caught by `--max-age-days` freshness, and re-fetching
 * recomputes and overwrites the verdict outright.
 */
const HASHED_INPUTS = [
  'declarantName',
  'declaredSeats',
  'declaredEik',
  'firstDeclaredYear',
  'scope',
  'nameGloballyUnique',
  'companyNameDistinctive',
];
const DEED_SIDE_INPUTS = new Set(['deed', 'outsideTr']);

/**
 * Canonical hash of everything on the declaration side of one `evidenceVerdict` call.
 *
 * A cached decision is only as trustworthy as its invalidation, and the failure mode of a missed
 * input is silent: a stale verdict about a real person, published. So this REFUSES an argument object
 * carrying a key it does not know — adding an input to `evidenceVerdict` without deciding whether it
 * belongs in the hash fails the run instead of quietly publishing yesterday's answer.
 *
 * @param {object} input the exact object handed to `evidenceVerdict`
 */
export function verdictInputsHash(input) {
  const unknown = Object.keys(input).filter(
    (k) => !HASHED_INPUTS.includes(k) && !DEED_SIDE_INPUTS.has(k),
  );
  if (unknown.length) {
    throw new Error(
      `verdictInputsHash: unrecognised evidenceVerdict input(s) ${unknown.join(', ')} — decide ` +
        `whether each belongs in HASHED_INPUTS before a cached verdict can be trusted`,
    );
  }
  const canonical = HASHED_INPUTS.map((k) => {
    const v = input[k];
    // Sorted, because `declaredSeats` arrives from a Set spread: iteration order is an accident of
    // insertion and must not make an unchanged input look changed.
    return [k, Array.isArray(v) ? [...v].map(String).sort() : (v ?? null)];
  });
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Split a link record into its routing keys and its decision inputs, and hash the latter.
 *
 * The ONE definition of what a link record is. Both sides of the boundary go through it — the crawler
 * reading the emitted JSONL, and the loader looking a verdict up — because a hash computed over even
 * slightly different objects would miss every cache entry and silently re-crawl the whole register.
 */
export function splitLinkRecord(rec) {
  const { linkKey, eik, ...input } = rec;
  return { linkKey, eik, input, inputsHash: verdictInputsHash(input) };
}

/**
 * The closed vocabularies a stored verdict may use, enforced at WRITE.
 *
 * `load.mjs` already refuses to seal a matched_fact outside the vocabulary — but that runs a month
 * later, on a row that has by then crossed into a cache which travels between runs (ADR-0037). The
 * schema's promise is „a ROLE, never the person holding it"; a promise checked only by the eventual
 * reader is a promise the writer never made. Sourced from evidence.mjs so there is one definition:
 * `isSealedFact` for the fact, and these two for the columns beside it.
 */
const VERDICT_KINDS = new Set([
  'bar_joint_stock',
  'confirmed',
  'document',
  'document_uncorroborated',
  'outside_tr',
  'refuted',
  'unknown',
]);
const REGISTRY_ROLES = new Set(['owner', 'manager']);

/**
 * Record the decision for one link. Replaces on re-decision so a refresh never duplicates a row.
 *
 * Screened by the same ЕГН rail as `upsertDeed` — the verdict crosses a run boundary, which makes it
 * the surface most worth screening, not least.
 */
export function upsertVerdict(db, v) {
  const eik = safeEik(v.eik);
  for (const [f, val] of Object.entries(v)) if (!EGN_EXEMPT.has(f)) assertNoEgnShape(val, f);
  if (!VERDICT_KINDS.has(String(v.kind)))
    throw new Error(
      `REFUSE TO STORE: verdict kind ${JSON.stringify(v.kind)} is outside the ladder`,
    );
  if (!isSealedFact(v.matchedFact))
    throw new Error(
      `REFUSE TO STORE: matched_fact ${JSON.stringify(v.matchedFact)} is outside the closed ` +
        `vocabulary — a name may have leaked out of a deed (#279 §9, ADR-0033 decision 5)`,
    );
  if (v.registryRole != null && !REGISTRY_ROLES.has(String(v.registryRole)))
    throw new Error(
      `REFUSE TO STORE: registry_role ${JSON.stringify(v.registryRole)} is not a role — this column ` +
        `holds an office, never the person filling it`,
    );
  db.prepare(
    `INSERT INTO verdicts (link_key, eik, rules_version, inputs_hash, kind, publishable,
        registry_role, matched_fact, entry_number, entry_date, short_name, latin_in_name,
        recon_terminated, recon_label, decided_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(link_key) DO UPDATE SET
        eik=excluded.eik, rules_version=excluded.rules_version, inputs_hash=excluded.inputs_hash,
        kind=excluded.kind, publishable=excluded.publishable, registry_role=excluded.registry_role,
        matched_fact=excluded.matched_fact, entry_number=excluded.entry_number,
        entry_date=excluded.entry_date, short_name=excluded.short_name,
        latin_in_name=excluded.latin_in_name, recon_terminated=excluded.recon_terminated,
        recon_label=excluded.recon_label, decided_at=excluded.decided_at`,
  ).run(
    String(v.linkKey),
    eik,
    String(v.rulesVersion),
    String(v.inputsHash),
    String(v.kind),
    v.publishable ? 1 : 0,
    v.registryRole ?? null,
    v.matchedFact ?? null,
    v.entryNumber ?? null,
    v.entryDate ?? null,
    v.shortName ? 1 : 0,
    v.latinInName ? 1 : 0,
    v.reconTerminated == null ? null : v.reconTerminated ? 1 : 0,
    v.reconLabel ?? null,
    v.decidedAt,
  );
}

/** One verdict by link key, camelCased and re-booleaned, or null. */
export function readVerdict(db, linkKey) {
  const r = db.prepare('SELECT * FROM verdicts WHERE link_key = ?').get(String(linkKey));
  if (!r) return null;
  return {
    linkKey: r.link_key,
    eik: r.eik,
    rulesVersion: r.rules_version,
    inputsHash: r.inputs_hash,
    kind: r.kind,
    publishable: r.publishable === 1,
    registryRole: r.registry_role,
    matchedFact: r.matched_fact,
    entryNumber: r.entry_number,
    entryDate: r.entry_date,
    shortName: r.short_name === 1,
    latinInName: r.latin_in_name === 1,
    reconTerminated: r.recon_terminated == null ? null : r.recon_terminated === 1,
    reconLabel: r.recon_label,
    decidedAt: r.decided_at,
  };
}

/**
 * Is the stored decision for `link` still the one today's rules and inputs would produce?
 *
 * Three ways to be stale, and all three must re-decide: the evidence rules moved, the declaration
 * behind the link moved, or the lookup is simply old. Anything else is a cache hit worth zero
 * requests — which is the entire point of ADR-0037.
 */
export function verdictIsCurrent(row, link, { rulesVersion, maxAgeDays = null, now = new Date() }) {
  if (!row) return false;
  if (row.rulesVersion !== rulesVersion) return false;
  if (row.inputsHash !== link.inputsHash) return false;
  if (maxAgeDays != null && Date.parse(row.decidedAt) < now.getTime() - maxAgeDays * 86_400_000)
    return false;
  return true;
}

/**
 * How much of `links` the verdict cache currently covers — the input to the incremental load gate.
 * `links` are `{linkKey, eik, inputsHash}`.
 */
export function verdictCoverage(db, links, opts) {
  let current = 0;
  for (const link of links) {
    if (verdictIsCurrent(readVerdict(db, link.linkKey), link, opts)) current++;
  }
  return {
    wanted: links.length,
    current,
    missing: links.length - current,
    ratio: links.length === 0 ? 1 : current / links.length,
  };
}

/**
 * The ЕИК that still need a deed fetched, because at least one link on them has no current verdict —
 * **oldest first**, never-decided before that.
 *
 * The ordering is load-bearing, not cosmetic. A run bounded by `--max-runtime-min` consumes this list
 * from the front and stops; sorted by ЕИК it would serve the SAME prefix every time and the tail would
 * never be decided at all, then lose its rows to the purge and take the published links with it. Sorted
 * by staleness the queue rotates: whatever waited longest goes first, so every ЕИК comes round.
 *
 * Deliberately keyed on links rather than on ЕИК: one company can carry several links, and a rules
 * bump invalidates them independently of when the deed was last seen. A company's position is its
 * WORST link's — the one waiting longest — so a company is never held back by its freshest claim.
 */
export function pendingVerdictEiks(db, links, opts) {
  const oldest = new Map();
  for (const link of links) {
    const row = readVerdict(db, link.linkKey);
    if (verdictIsCurrent(row, link, opts)) continue;
    const eik = safeEik(link.eik);
    // '' for never-decided, so it sorts ahead of every ISO timestamp: a link that has never had a
    // verdict is further from being publishable than one whose verdict merely went stale.
    const waitingSince = row?.decidedAt ?? '';
    const prev = oldest.get(eik);
    if (prev === undefined || waitingSince < prev) oldest.set(eik, waitingSince);
  }
  // Tie-broken on ЕИК so the order is total and a run is reproducible.
  return [...oldest.entries()]
    .sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : 1))
    .map(([eik]) => eik);
}

/**
 * Deed retention. ADR-0033 decision 5 — a PRIVACY obligation over third-party personal data, and the
 * reason this number exists at all. One refresh cycle plus slack. See purgeExpired.
 */
export const RETENTION_DAYS = 35;

/**
 * Verdict retention, and deliberately a DIFFERENT number for a different reason.
 *
 * A verdict holds no personal data (ADR-0037), so nothing obliges us to delete it on a privacy clock;
 * what the number bounds is how stale a published claim's evidence may be. It must therefore exceed
 * the time it takes for a link to come round again — `--max-age-days` (30) plus one cadence gap (7)
 * plus queue slack — or the purge would delete verdicts before the crawl could refresh them, and the
 * surface would shrink on its own schedule. 45 carries that margin.
 */
export const VERDICT_RETENTION_DAYS = 45;

/**
 * Which of `wanted` still need a request — the resumability primitive.
 *
 * `maxAgeDays` is a FRESHNESS knob, not the retention rail: past it a cached row becomes pending and
 * is re-requested. Retention — actually deleting the personal data — is purgeExpired below. Refreshing
 * a deed rewrites it; only purging removes it, and conflating the two is how a documented TTL ends up
 * never deleting anything. Pass no `maxAgeDays` to treat any cached row as current.
 */
export function pendingEiks(db, wanted, { maxAgeDays = null, now = new Date() } = {}) {
  const cutoff = maxAgeDays == null ? null : now.getTime() - maxAgeDays * 86_400_000;
  const out = [];
  const stmt = db.prepare('SELECT fetched_at, status FROM deeds WHERE eik = ?');
  for (const raw of wanted) {
    const row = stmt.get(safeEik(raw));
    if (!row) {
      out.push(String(raw));
      continue;
    }
    // A provisional negative is an observation, not an answer — it must be re-asked regardless of how
    // fresh it is, or the second look that confirms it would never happen.
    if (row.status === 'outside_tr_pending') {
      out.push(String(raw));
      continue;
    }
    if (cutoff != null && Date.parse(row.fetched_at) < cutoff) out.push(String(raw));
  }
  return out;
}

/**
 * How much of `wanted` the cache actually covers — the input to the fail-closed load gate.
 * `outside_tr` counts as COVERED: it is a known, resolved outcome, not a gap. A partial cache must
 * make the loader throw rather than publish a decimated surface (ADR-0033 decision 7).
 */
export function coverage(db, wanted) {
  let fetched = 0,
    outsideTr = 0;
  const stmt = db.prepare('SELECT status FROM deeds WHERE eik = ?');
  for (const raw of wanted) {
    const row = stmt.get(safeEik(raw));
    if (!row) continue;
    // A provisional negative is NOT covered: it is one observation short of an answer.
    if (row.status === 'outside_tr') outsideTr++;
    else if (row.status !== 'outside_tr_pending') fetched++;
    else continue;
  }
  const covered = fetched + outsideTr;
  return {
    wanted: wanted.length,
    fetched,
    outsideTr,
    covered,
    missing: wanted.length - covered,
    ratio: wanted.length === 0 ? 1 : covered / wanted.length,
  };
}

/**
 * Delete deed data past its retention — ADR-0033 decision 5's purge step.
 *
 * This is a PRIVACY rail, not a cache-eviction policy, and the distinction decides the design. The raw
 * JSON under scratch/tr/deeds/ is the only place third-party names live: co-owners and managers who
 * hold no public office, and the company's street address. We keep it because re-deriving a boolean is
 * cheaper than re-requesting somebody else's register — not because we are entitled to hold it.
 *
 * Retention is 35 days: one monthly refresh cycle plus slack. Under normal operation nothing is ever
 * purged, because the refresh at ~30 days rewrites the row first. What this actually catches is the
 * residue — a company that dropped out of the candidate set, or a refresh that failed — which is
 * exactly the data with no remaining reason to exist.
 *
 * Orphaned files are removed too: a raw deed with no index row is unreachable by every read path here,
 * so it is pure retained personal data.
 *
 * @returns {{rows:number, files:number, orphans:number}} what was removed
 */
export function purgeExpired(
  db,
  rawDir,
  {
    retentionDays = RETENTION_DAYS,
    verdictRetentionDays = VERDICT_RETENTION_DAYS,
    now = new Date(),
    unlink = fs.unlinkSync,
  } = {},
) {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  const verdictCutoff = new Date(now.getTime() - verdictRetentionDays * 86_400_000).toISOString();
  const expired = db.prepare('SELECT eik, raw_path FROM deeds WHERE fetched_at < ?').all(cutoff);

  let files = 0;
  for (const row of expired) {
    if (!row.raw_path) continue;
    // Resolve through the same safeEik path-traversal rail the writer used, never the stored string.
    try {
      unlink(path.join(rawDir, `${safeEik(row.eik)}.json`));
      files++;
    } catch (e) {
      // Already gone is the goal state, not a failure. Anything else must surface — a purge that
      // silently fails to delete is worse than no purge, because it reports success.
      if (e.code !== 'ENOENT') throw e;
    }
  }
  db.prepare('DELETE FROM deeds WHERE fetched_at < ?').run(cutoff);

  let orphans = 0;
  let names = [];
  try {
    names = fs.readdirSync(rawDir);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // no raw dir yet — nothing to orphan
  }
  const known = new Set(
    db
      .prepare('SELECT eik FROM deeds')
      .all()
      .map((r) => `${r.eik}.json`),
  );
  for (const name of names) {
    // `.tmp-<pid>` files are atomicWrite's half-written deeds. A crash between write and rename leaves
    // one holding third-party names under a name no `.json` filter ever sees — so sweep those too.
    const isTemp = /\.tmp-\d+$/.test(name);
    if ((!name.endsWith('.json') && !isTemp) || known.has(name)) continue;
    // The same ENOENT tolerance the expired loop above has, and for a sharper reason here: this loop
    // runs AFTER the DB DELETE has committed, so an unguarded throw half-purges — rows gone, files
    // still on disk — and reports the whole run as failed. The listing is a snapshot, so a name can
    // legitimately be gone by the time we reach it (a concurrent purge, an operator clearing scratch).
    // Already gone is the goal state. Anything else still surfaces: a purge that cannot delete has
    // left third-party names on disk, and reporting success would be the failure it exists to prevent.
    try {
      unlink(path.join(rawDir, name));
      orphans++;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  // Verdicts age out on their OWN clock, longer than the deeds'. They hold no third-party name
  // (ADR-0037), so this is not the privacy rail the deed purge is — it is the promise that a published
  // claim rests on a lookup made inside a stated window. Sharing the deed's 35 days would delete
  // verdicts faster than a budget-bounded crawl can refresh them, and the surface would then shrink
  // for no reason but the clock.
  // Counted off the DELETE itself rather than a SELECT COUNT(*) before it. Two statements asking one
  // question can only ever agree or be wrong; `changes` is what was actually deleted, by construction.
  const verdicts = db.prepare('DELETE FROM verdicts WHERE decided_at < ?').run(verdictCutoff);

  return { rows: expired.length, files, orphans, verdicts: verdicts.changes };
}
