// TEST HELPER — not part of the pipeline, and deliberately not named *.test.mjs so the runner does
// not execute it as a suite.
//
// Since ADR-0037 the decision is reached by the CRAWLER, beside the deed, and `load.mjs` only reads
// what was decided. A fixture that seeds deeds alone therefore exercises nothing: the loader would
// find no verdict and hold every link. This helper closes that gap the honest way — it runs the real
// `decideLinks`, so a load test still exercises the real evidence ladder rather than hand-written
// verdict rows that could drift away from what `evidenceVerdict` actually returns.
//
// It stops short of running the whole crawler on purpose: `run()` also applies the ЕИК checksum
// filter, and the fixtures use memorable repdigit codes that no checksum would accept. That filter
// has its own tests in scripts/tr/fetch-deeds.test.mjs; re-testing it here would only force every
// fixture ЕИК to change.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCache, upsertDeed, markOutsideTr, readDeed } from '../tr/cache.mjs';
import { readLinksFile, decideLinks } from '../tr/fetch-deeds.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

/** Run `load.mjs --emit-candidates` against a fixture work DB and return the emitted link records. */
export function emitLinkRecords({ workDb, staging, trDb }) {
  execFileSync(
    'node',
    [
      '--import',
      path.join(HERE, 'register-ts.mjs'),
      path.join(HERE, 'load.mjs'),
      '--emit-candidates',
    ],
    {
      cwd: ROOT,
      env: { ...process.env, CACBG_DB: workDb, CACBG_STAGING: staging, TR_CACHE_DB: trDb },
      stdio: 'pipe',
    },
  );
  return readLinksFile(path.join(staging, 'candidate-links.jsonl'));
}

/**
 * Decide every fixture link against its fixture deed, exactly as the crawler would.
 *
 * `deedFor(eik)` returns `{ deed }` for a company in the register, `{ outsideTr: true }` for one that
 * is not, or `null` for one the crawl never reached — which must leave NO verdict, because that is
 * what an incomplete cache looks like and several tests turn on it.
 */
export function seedVerdicts({
  workDb,
  staging,
  trDb,
  deedFor,
  now = new Date('2026-08-05T00:00:00Z'),
}) {
  const links = emitLinkRecords({ workDb, staging, trDb });
  const db = openCache(trDb);
  try {
    for (const eik of [...new Set(links.map((l) => l.eik))]) {
      const entry = deedFor(eik);
      if (entry == null) continue; // never reached — no deed row, no verdict
      if (entry.outsideTr) {
        markOutsideTr(db, eik, 'HTTP 200, empty body', now);
        decideLinks(db, { eik, deed: null, outsideTr: true, links, now });
        continue;
      }
      // Only when the fixture has not already written the row. Re-upserting here would overwrite the
      // columns the caller populated by hand with NULLs — harmless while nothing reads them, and a trap
      // the moment something does.
      if (!readDeed(db, eik)) {
        upsertDeed(db, {
          eik,
          status: 'fetched',
          httpStatus: 200,
          fetchedAt: now.toISOString(),
          legalFormCode: entry.deed.legalForm ?? null,
        });
      }
      decideLinks(db, { eik, deed: entry.deed, outsideTr: false, links, now });
    }
  } finally {
    db.close();
  }
  return links;
}

/** Convenience for a fixture that keeps its deeds as plain JSON on disk. */
export function readFixtureDeed(rawDir, eik) {
  const file = path.join(rawDir, `${eik}.json`);
  return fs.existsSync(file) ? { deed: JSON.parse(fs.readFileSync(file, 'utf8')) } : null;
}
