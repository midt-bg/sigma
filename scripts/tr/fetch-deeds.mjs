// The deed crawler (issue #279 §3, ADR-0033). One request per candidate ЕИК, sequential and paced.
//
// This is the only component in the project that touches a public register at volume, so what it
// REFUSES to do is the substance:
//
//   • It never goes faster than 1 request / 3 s, and the flag that sets the pace cannot be used to go
//     faster — only slower. Spec §3.3 permits a bounded per-ЕИК lookup and forbids bulk scraping; the
//     limiter is the operator's only way to state a preference, and tuning around it empirically is
//     what that rule exists to prevent.
//   • It never retries a 429 straight away, and it records NOTHING about the ЕИК that hit one — that
//     ЕИК is unknown, not absent, and the block is a fact about us rather than about the company. What
//     it does instead is WAIT: the block clears in ~161s (ADR-0036), so the crawler cools down for
//     RATE_LIMIT_COOLDOWN_MS and re-requests the same ЕИК. Three cooldowns without a success still end
//     the run with exit 2, so a genuinely sustained block stays distinguishable from the ordinary
//     rhythm. Waiting out a self-clearing limiter asks LESS of the register than the pace floor
//     already permits; it is the opposite of tuning around it.
//   • It never follows a link out of a deed. The candidate set is closed: whatever the caller passes
//     in, nothing more. This is what keeps a bounded lookup from drifting into a crawl.
//   • It only writes „outside the register" on a DOCUMENTED negative — measured to be an HTTP 200
//     with an empty body, not the 404 the issue predicts. A 5xx or a timeout is transient, and caching
//     it as permanent would turn an outage into data that §8 never revisits.
//
// Resumable by construction: the cache is consulted first, so an interrupted run picks up exactly
// where it stopped and a complete cache costs zero requests. `--max-runtime-min` leans on exactly
// that — a run may stop cleanly when its wall-clock budget is spent, because the next one continues
// rather than restarting.

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
 * requests against an endpoint that is already failing. This counts NON-rate-limit failures only —
 * a 429 is a cooldown with its own counter below, and folding the two together would let a slow,
 * healthy crawl trip a breaker meant for a broken endpoint.
 */
export const BREAKER_TRIP = 5;
/** Attempts per candidate, per #279 §3. Exported so the breaker's request budget is derivable. */
export const TRIES_PER_EIK = 5;

/**
 * How long to wait out a 429 before re-requesting the SAME ЕИК.
 *
 * The block clears on its own in ~161s (measured 2026-08-19, ADR-0036) — it is a cooldown, not the
 * sustained wall ADR-0033 recorded. 180s carries margin over a single measurement. Waiting is not
 * tuning around the limiter: it asks for strictly less than the pace floor already permits.
 */
export const RATE_LIMIT_COOLDOWN_MS = 180_000;

/**
 * Cooldowns spent on ONE ЕИК before the run gives up with exit 2.
 *
 * A block that survives three full cooldowns is not the rhythm ADR-0036 measured — it is either a
 * much longer ban or a change at the register, and neither is something to sit through for hours.
 * The counter resets on any success, so a healthy crawl that meets the limiter every few ЕИК never
 * approaches it.
 */
export const MAX_COOLDOWNS = 3;

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
  // Wall-clock ceiling for the crawl loop. Only safe because progress is durable: the run stops
  // between two ЕИК, having marked everything it resolved, and the next run resumes from the cache.
  // Absent = no ceiling, which is the right default for a local operator running to completion.
  const runtimeRaw = get('max-runtime-min', '');
  return {
    eiksFile,
    limit: limitRaw ? posInt(limitRaw, 'limit') : Infinity,
    minIntervalMs,
    maxAgeDays: maxAgeRaw ? posInt(maxAgeRaw, 'max-age-days') : null,
    retentionDays: retentionRaw ? posInt(retentionRaw, 'retention-days') : RETENTION_DAYS,
    maxRuntimeMs: runtimeRaw ? posInt(runtimeRaw, 'max-runtime-min') * 60_000 : Infinity,
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
 * One ЕИК, waiting out any rate-limit cooldown. Separated from the crawl loop so „what a block means"
 * is one testable decision rather than control flow tangled through the loop body.
 *
 * Returns exactly one of:
 *   `{ res }`      the register answered (any status the caller must interpret)
 *   `{ err }`      a transient failure the caller counts toward the breaker
 *   `{ blocked }`  the block outlasted `maxCooldowns` — the caller ends the run
 *
 * The `tries` asymmetry is load-bearing. A block has two faces (ADR-0036): an immediate 429, and a
 * STALLED connection that only surfaces as a timeout. Before the first cooldown we do not know we are
 * blocked, so a network fault gets the documented retry budget. Once we do know, a stall is the block
 * talking, and spending five 20s attempts on it feeds a tarpit — so subsequent attempts get exactly
 * one, and any throw is read as „still blocked" rather than as a fresh transient.
 */
export async function fetchOne(
  eik,
  {
    httpGet,
    sleep,
    cooldownMs = RATE_LIMIT_COOLDOWN_MS,
    maxCooldowns = MAX_COOLDOWNS,
    log = console.error,
  } = {},
) {
  for (let cooldowns = 0; ; ) {
    try {
      return {
        res: await politeTrGet(deedUrl(eik), {
          httpGet,
          sleep,
          tries: cooldowns === 0 ? TRIES_PER_EIK : 1,
        }),
      };
    } catch (err) {
      const blocked = err instanceof RateLimitError || cooldowns > 0;
      if (!blocked) return { err };
      if (cooldowns >= maxCooldowns) return { blocked: true, cooldowns };
      cooldowns++;
      log(
        `  ${eik}: rate limited — cooling down ${Math.round(cooldownMs / 1000)}s ` +
          `(${cooldowns}/${maxCooldowns}), then re-requesting the same ЕИК`,
      );
      await sleep(cooldownMs);
    }
  }
}

/**
 * Crawl the candidate ЕИК. Returns the intended process exit code, so the decision is testable
 * without a global side effect:
 *   0 — every candidate resolved, or the run was deliberately bounded (--limit, --max-runtime-min)
 *   1 — at least one candidate is unresolved (transient failure, refused deed, breaker tripped)
 *   2 — the register blocked us for longer than MAX_COOLDOWNS cooldowns; nothing was marked for the
 *       ЕИК that hit it. Everything resolved before that point is cached and the next run continues.
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
  const { eiksFile, limit, minIntervalMs, maxAgeDays, retentionDays, maxRuntimeMs } =
    parseTrOptions(argv);

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
    let deadlineHit = 0;
    const startedAt = now().getTime();

    for (const eik of todo) {
      // Checked BEFORE the pace sleep, so a spent budget costs neither a wait nor a request. The
      // remaining candidates are left untouched — never attempted is not the same as unresolved, and
      // counting them would turn a deliberate stop into a failure.
      if (now().getTime() - startedAt >= maxRuntimeMs) {
        deadlineHit = todo.length - todo.indexOf(eik);
        console.log(
          `runtime budget spent — stopping cleanly with ${deadlineHit} candidate(s) unattempted; ` +
            `the next run resumes from the cache`,
        );
        break;
      }
      if (!first) await sleep(minIntervalMs); // pace BETWEEN requests, not before the first
      first = false;

      const outcome = await fetchOne(eik, { httpGet, sleep });
      if (outcome.blocked) {
        // Nothing is recorded for this ЕИК: the block is a fact about us, not about the company.
        console.error(
          `RATE LIMITED through ${outcome.cooldowns} cooldown(s) on ${eik} — STOPPING. ` +
            `Progress so far is cached; re-run later.`,
        );
        return 2;
      }
      if (outcome.err) {
        const err = outcome.err;
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
      const res = outcome.res;

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
      // Deliberately still exit 1. „Ran out of time" is not a failure (the candidates were never
      // attempted, and the next run takes them), but a candidate we ASKED about and could not resolve
      // is a real one — the deadline must not launder it into a green run.
      console.error(`${unresolved} candidate(s) unresolved — the cache is incomplete`);
      return 1;
    }
    if (deadlineHit)
      console.log(`stopped on the runtime budget; ${deadlineHit} left for the next run`);
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
