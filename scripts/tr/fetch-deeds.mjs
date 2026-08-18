// The deed crawler (issue #279 §3, ADR-0033). One request per candidate ЕИК, sequential and paced.
//
// This is the only component in the project that touches a public register at volume, so what it
// REFUSES to do is the substance:
//
//   • It never goes faster than 1 request / 3 s, and the flag that sets the pace cannot be used to go
//     faster — only slower. Spec §3.3 permits a bounded per-ЕИК lookup and forbids bulk scraping; the
//     limiter is the operator's only way to state a preference, and tuning around it empirically is
//     what that rule exists to prevent.
//   • It never retries a 429. The block is sustained (see client.mjs), so a 429 ends the run with its
//     own exit code and records NOTHING about the ЕИК that hit it — that ЕИК is unknown, not absent.
//   • It never follows a link out of a deed. The candidate set is closed: whatever the caller passes
//     in, nothing more. This is what keeps a bounded lookup from drifting into a crawl.
//   • It only writes „outside the register" on a DOCUMENTED negative — measured to be an HTTP 200
//     with an empty body, not the 404 the issue predicts. A 5xx or a timeout is transient, and caching
//     it as permanent would turn an outage into data that §8 never revisits.
//
// Resumable by construction: the cache is consulted first, so an interrupted run picks up exactly
// where it stopped and a complete cache costs zero requests.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertTrScratchIgnored, TR_DB, TR_RAW, safeEik, deedPath } from './paths.mjs';
import { eikChecksumValid } from './eik.mjs';
import { deedUrl, politeTrGet, RateLimitError, httpsGet } from './client.mjs';
import {
  openCache,
  upsertDeed,
  markOutsideTr,
  pendingEiks,
  purgeExpired,
  RETENTION_DAYS,
} from './cache.mjs';
import {
  assertUicEcho,
  registryLegalForm,
  registrySeat,
  latestOwnershipEntryDate,
} from './deed.mjs';

/** The documented polite pace: 1 request / 3 s (#279 §3). A floor, never a target to tune down. */
export const MIN_INTERVAL_MS = 3000;

/**
 * Consecutive unresolved ЕИК before the run gives up rather than keep hammering.
 *
 * Deliberately small, because the unit is ЕИК and not requests: each unresolved candidate costs up to
 * 5 attempts (#279 §3's documented retry budget), so the breaker's real cost is `BREAKER_TRIP × 5`
 * requests against an endpoint that is already failing. At 10 that would be ~50 — the exact volume at
 * which the register was observed to start returning a sustained 429. At 5 the worst case is ~25,
 * which the same observation saw pass without a block.
 */
export const BREAKER_TRIP = 5;
/** Attempts per candidate, per #279 §3. Exported so the breaker's request budget is derivable. */
export const TRIES_PER_EIK = 5;

export function parseTrOptions(argv) {
  const get = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const posInt = (raw, name) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1)
      throw new Error(`--${name} must be a positive integer, got ${JSON.stringify(raw)}`);
    return n;
  };

  const eiksFile = get('eiks-file', '');
  if (!eiksFile) throw new Error('--eiks-file is required (the closed candidate set)');

  const limitRaw = get('limit', '');
  const intervalRaw = get('min-interval-ms', '');
  const minIntervalMs = intervalRaw ? posInt(intervalRaw, 'min-interval-ms') : MIN_INTERVAL_MS;
  // Slower is always allowed; faster is not a knob. Making this un-passable is the point.
  if (minIntervalMs < MIN_INTERVAL_MS) {
    throw new Error(
      `--min-interval-ms may not go below the documented pace of ${MIN_INTERVAL_MS}ms — ` +
        `the register's rate limit is a stated preference, not an obstacle to tune around`,
    );
  }
  const maxAgeRaw = get('max-age-days', '');
  // --max-age-days is FRESHNESS (re-request past it); --retention-days is RETENTION (delete past it).
  // They are separate flags because they are separate obligations: refreshing rewrites the personal
  // data, only purging removes it. Retention defaults to the ADR's 35 days rather than to „off", so
  // the rail holds for an operator who passes neither.
  const retentionRaw = get('retention-days', '');
  return {
    eiksFile,
    limit: limitRaw ? posInt(limitRaw, 'limit') : Infinity,
    minIntervalMs,
    maxAgeDays: maxAgeRaw ? posInt(maxAgeRaw, 'max-age-days') : null,
    retentionDays: retentionRaw ? posInt(retentionRaw, 'retention-days') : RETENTION_DAYS,
  };
}

/** Read the closed candidate set: one ЕИК per line, blanks and `#` comments ignored. */
export function readEiksFile(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

function atomicWrite(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

/**
 * Crawl the candidate ЕИК. Returns the intended process exit code, so the decision is testable
 * without a global side effect:
 *   0 — every candidate resolved (or the run was deliberately bounded by --limit)
 *   1 — at least one candidate is unresolved (transient failure, refused deed, breaker tripped)
 *   2 — the register rate-limited us; the run stopped and nothing was marked
 *
 * Every I/O edge is injectable so the whole policy is exercised offline.
 */
export async function run({
  httpGet = httpsGet,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => new Date(),
  guard = assertTrScratchIgnored,
  dbFile = TR_DB,
  rawDir = TR_RAW,
  argv = process.argv,
} = {}) {
  guard();
  const { eiksFile, limit, minIntervalMs, maxAgeDays, retentionDays } = parseTrOptions(argv);

  const requested = readEiksFile(eiksFile);
  // A shape- or checksum-invalid code is dropped BEFORE any request: it cannot name a real company,
  // so asking about it would spend the register's budget to learn nothing.
  const candidates = [];
  let invalid = 0;
  for (const raw of requested) {
    try {
      const eik = safeEik(raw);
      if (!eikChecksumValid(eik)) throw new Error('checksum');
      candidates.push(eik);
    } catch {
      invalid++;
    }
  }

  const db = openCache(dbFile);
  try {
    const pending = pendingEiks(db, candidates, { maxAgeDays, now: now() });
    const todo = Number.isFinite(limit) ? pending.slice(0, limit) : pending;
    console.log(
      `candidates ${candidates.length} · invalid ${invalid} · cached ${candidates.length - pending.length} · to fetch ${todo.length}`,
    );

    let unresolved = 0;
    let consecutive = 0;
    let first = true;

    for (const eik of todo) {
      if (!first) await sleep(minIntervalMs); // pace BETWEEN requests, not before the first
      first = false;

      let res;
      try {
        res = await politeTrGet(deedUrl(eik), { httpGet, sleep, tries: TRIES_PER_EIK });
      } catch (err) {
        if (err instanceof RateLimitError) {
          // Stop the whole run. Recording anything here would attribute the register's throttle to
          // this ЕИК, which is a fact about us, not about the company.
          console.error(`${err.message}\nSTOPPING — re-run later; progress so far is cached.`);
          return 2;
        }
        console.error(
          `  ${eik}: ${err instanceof Error ? err.message : err} (transient, not cached)`,
        );
        unresolved++;
        consecutive++;
        if (consecutive >= BREAKER_TRIP) {
          console.error(`breaker: ${consecutive} consecutive failures — aborting the run`);
          return 1;
        }
        continue;
      }

      // ── the documented negatives ────────────────────────────────────────────
      // MEASURED 2026-08-05: an ЕИК that is not a търговец answers **HTTP 200 with a ZERO-BYTE body**,
      // not a 404 and not the HTML #279 §3 predicts. Verified on Община София (000696327): empty on
      // two consecutive requests, while a real company returned its full 34,398-byte deed in the same
      // window — so it is the register's answer, not an outage.
      //
      // The distinction that keeps R6 honest is the STATUS, not the empty body: an empty body under
      // 200 is the register saying „no deed"; an empty body under 5xx is a failure and stays
      // transient. Getting this backwards either caches a false negative forever or leaves ~4 ЕИК
      // permanently unresolved so the run can never exit 0.
      if (res.status === 200 && res.body.length === 0) {
        markOutsideTr(db, eik, 'HTTP 200, empty body — no deed in the Търговски регистър', now());
        consecutive = 0;
        continue;
      }
      if (res.status === 404) {
        markOutsideTr(db, eik, 'HTTP 404 — not in the Търговски регистър (BULSTAT/ДЗЗД?)', now());
        consecutive = 0;
        continue;
      }
      if (res.status !== 200) {
        console.error(`  ${eik}: HTTP ${res.status} after retries (transient, not cached)`);
        unresolved++;
        consecutive++;
        if (consecutive >= BREAKER_TRIP) {
          console.error(`breaker: ${consecutive} consecutive failures — aborting the run`);
          return 1;
        }
        continue;
      }

      // ONE refuse-and-continue block around EVERYTHING derived from the response — the JSON, the UIC
      // echo, and the HTML parsing alike. The parsing used to sit outside it, which made the block's
      // own promise false: a throw from deed.mjs escaped the loop, escaped run(), and killed the
      // process, so one malformed deed ended a crawl that had already spent its paced request budget.
      // The decode guard in deed.mjs removes the one throw we know of; this is the rail that holds when
      // the next one appears, and the cost of being wrong here is measured in hours of pacing.
      try {
        const deed = JSON.parse(res.body.toString('utf8'));
        // The deed we got back must be the deed we asked for, or every claim derived from it names
        // the wrong company (R8).
        assertUicEcho(deed, eik);

        // The raw response is the ONLY place names live; it stays under git-ignored scratch. Written
        // only after the echo check, so a deed for the wrong company never lands on disk.
        atomicWrite(deedPath(eik, rawDir), res.body);
        const seat = registrySeat(deed);
        const form = registryLegalForm(deed);
        upsertDeed(db, {
          eik,
          status: 'fetched',
          httpStatus: 200,
          fetchedAt: now().toISOString(),
          rawPath: path.relative(rawDir, deedPath(eik, rawDir)),
          bodySha256: crypto.createHash('sha256').update(res.body).digest('hex'),
          legalFormCode: form.code,
          legalFormVerdict: form.verdict,
          seatNormalized: seat.settlement || null,
          seatEntryDate: seat.entryDate,
          latestOwnEntryDate: latestOwnershipEntryDate(deed),
        });
      } catch (err) {
        console.error(`  ${eik}: REFUSED — ${err instanceof Error ? err.message : err}`);
        unresolved++;
        consecutive++;
        continue;
      }
      consecutive = 0;
    }

    if (unresolved > 0) {
      console.error(`${unresolved} candidate(s) unresolved — the cache is incomplete`);
      return 1;
    }
    return 0;
  } finally {
    // The purge step ADR-0033 decision 5 puts „in the same job" — in `finally`, and that placement is
    // the point. Retention is an obligation about other people's data, not a reward for a clean run,
    // so it must also happen on the paths that leave early: a 429 (exit 2), a tripped breaker, an
    // unresolved candidate. Under normal operation it removes nothing, because the monthly refresh
    // rewrites each row well inside the window; anything it does delete is residue — a company that
    // left the candidate set, or a refresh that never landed.
    try {
      const purged = purgeExpired(db, rawDir, { retentionDays, now: now() });
      if (purged.rows || purged.files || purged.orphans) {
        console.log(
          `purged ${purged.rows} row(s), ${purged.files} raw deed(s), ${purged.orphans} orphan(s) past ${retentionDays}d retention`,
        );
      }
    } catch (e) {
      // A failed purge must be loud but must not mask the run's own outcome — especially not a 429,
      // whose exit code is what tells the operator to back off.
      console.error(`purge failed: ${e.message}`);
    }
    db.close();
  }
}

// CLI entry. Kept off the import path so the module stays testable.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
