// The verdict cache — the hand-off between the decision pass and the loader, and the PII rail on it
// (issue #279, ADR-0033 decision 5, ADR-0037, ADR-0041).
//
// The decision pass (decide.mjs) decides every link against the registry facts of its company and records
// the verdict here; load.mjs reads it back. A verdict is the one registry-derived row the served tables are
// built from, so two rails live here:
//
//   1. The INDEX stores no name at all — ЕИК, dates, codes, verdicts. A registry fact is read only to
//      produce a boolean, and no name from it enters this file, a response or a log.
//   2. Nothing may carry a STANDALONE ten-digit run. That is the ЕГН shape, and the check is sound
//      precisely because an ЕИК is 9 or 13 digits — never 10 — so it cannot reject a legitimate
//      identifier. „Standalone" is load-bearing: a 13-digit ЕИК contains ten-digit substrings, so an
//      unanchored match would refuse every клон. ЕГН was absent from every payload examined; this is
//      the rail for the day one leaks.
//
// The file is rebuilt from nothing on every run: every fact is at hand, so nothing decided against an
// older registry can linger.

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
  raw_path             TEXT,              -- unused since the registry layer (ADR-0041): no deed is written
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
-- The decision itself, per (link, ЕИК) — ADR-0037: a role, an entry reference and booleans. link_key is
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
  -- reconcileTermination's answer, kept for the same reason as the verdict: it too is a question
  -- about the register (is this declarant still a registered owner?) whose answer is a boolean and a role
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
  ['role_ended_on', 'TEXT'],
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
 * A corrupt one is moved aside and the run starts empty rather than failing on it: the decision pass
 * rebuilds the verdicts from the registry facts anyway, so what is lost is only what it would redo.
 */
export function openCache(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && !cacheIsUsable(file)) {
    const quarantined = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, quarantined);
    console.error(
      `TR cache at ${file} failed its integrity check — moved to ${quarantined}, starting empty. ` +
        `The verdicts are decided again from the registry facts rather than read from a damaged file.`,
    );
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  // CREATE TABLE IF NOT EXISTS is a no-op on an existing cache, so an older file would meet a query
  // naming a column it does not have. Added idempotently rather than by recreating the table, so an
  // existing file keeps its rows.
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
// is matched as a WHOLE: an unanchored /\d{10}/ matches INSIDE the 13-digit ЕИК of a клон — and inside
// every value derived from one — so every branch office would be refused.
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
 * REGISTRY-side inputs (`registry`, `outsideTr`) are deliberately absent: they are not what this hash
 * invalidates against. The decision pass decides every link again against the registry as it stands,
 * so a changed partida recomputes and overwrites the verdict outright.
 */
const HASHED_INPUTS = [
  'declarantName',
  'registryIndent',
  'declaredSeats',
  'declaredEik',
  'firstDeclaredYear',
  'historicalDeclaredYear',
  'scope',
  'nameGloballyUnique',
  'companyNameDistinctive',
];
const REGISTRY_SIDE_INPUTS = new Set(['registry', 'outsideTr']);

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
    (k) => !HASHED_INPUTS.includes(k) && !REGISTRY_SIDE_INPUTS.has(k),
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
 * The ONE definition of what a link record is. Both sides of the boundary go through it — the decision
 * pass reading the emitted JSONL, and the loader looking a verdict up — because a hash computed over even
 * slightly different objects would miss every verdict and silently hold the whole surface.
 */
export function splitLinkRecord(rec) {
  const { linkKey, eik, ...input } = rec;
  return { linkKey, eik, input, inputsHash: verdictInputsHash(input) };
}

/**
 * The closed vocabularies a stored verdict may use, enforced at WRITE.
 *
 * `load.mjs` already refuses to seal a matched_fact outside the vocabulary — but the schema's promise
 * is „a ROLE, never the person holding it", and a promise checked only by the eventual reader is a
 * promise the writer never made. Sourced from evidence.mjs so there is one definition:
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
  // Canonical keys contain a SHA-256, which can contain ten consecutive digits.
  // Exempt only the complete generated shape, with this verdict's validated EIK.
  const canonicalKey = String(v.linkKey).startsWith('person:identity:');
  if (
    canonicalKey &&
    !new RegExp(`^person:identity:[a-f0-9]{64}\\|${eik}(?:\\|family)?$`).test(v.linkKey)
  )
    throw new Error('REFUSE TO STORE: malformed canonical person link key');
  for (const [f, val] of Object.entries(v))
    if (!EGN_EXEMPT.has(f) && !(f === 'linkKey' && canonicalKey)) assertNoEgnShape(val, f);
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
        recon_terminated, recon_label, decided_at, role_ended_on)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(link_key) DO UPDATE SET
        eik=excluded.eik, rules_version=excluded.rules_version, inputs_hash=excluded.inputs_hash,
        kind=excluded.kind, publishable=excluded.publishable, registry_role=excluded.registry_role,
        matched_fact=excluded.matched_fact, entry_number=excluded.entry_number,
        entry_date=excluded.entry_date, short_name=excluded.short_name,
        latin_in_name=excluded.latin_in_name, recon_terminated=excluded.recon_terminated,
        recon_label=excluded.recon_label, decided_at=excluded.decided_at,
        role_ended_on=excluded.role_ended_on`,
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
    v.roleEndedOn ?? null,
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
    roleEndedOn: r.role_ended_on ?? null,
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
