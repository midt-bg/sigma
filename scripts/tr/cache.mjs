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
// Resumability is the other job: the register throttles hard and a 429 ends the run (client.mjs), so a
// crawl must be able to pick up exactly where it stopped without re-requesting what it already has.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { safeEik } from './paths.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deeds (
  eik                  TEXT PRIMARY KEY,
  status               TEXT NOT NULL,     -- fetched | outside_tr
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
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Open (creating if absent) the cache at `file`. Idempotent — never wipes an existing cache. */
export function openCache(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
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
const EGN_EXEMPT = new Set(['eik', 'bodySha256']);

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
 * Mark an ЕИК as not present in the Trade Register (ДЗЗД, БУЛСТАT associations).
 *
 * PERMANENT BY INTENT, so the caller must only reach here on a DOCUMENTED positive response. A 429,
 * a 5xx or a timeout is transient and must never be cached as a negative — that is how a temporary
 * wall becomes permanent data (R6).
 */
export function markOutsideTr(db, eik, reason, now = new Date()) {
  upsertDeed(db, {
    eik,
    status: 'outside_tr',
    fetchedAt: now.toISOString(),
    outsideReason: reason,
  });
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

/** ADR-0033 decision 5: one monthly refresh cycle plus slack. See purgeExpired. */
export const RETENTION_DAYS = 35;

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
  const stmt = db.prepare('SELECT fetched_at FROM deeds WHERE eik = ?');
  for (const raw of wanted) {
    const row = stmt.get(safeEik(raw));
    if (!row) {
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
    if (row.status === 'outside_tr') outsideTr++;
    else fetched++;
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
  { retentionDays = RETENTION_DAYS, now = new Date(), unlink = fs.unlinkSync } = {},
) {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
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
    if (!name.endsWith('.json') || known.has(name)) continue;
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
  return { rows: expired.length, files, orphans };
}
