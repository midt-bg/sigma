// node:test — the deed cache. Its job is to make the crawl resumable and to hold the PII rail.
//
// The rail (ADR-0033 decision 5): the INDEX stores no name at all — only ЕИК, dates, codes, verdicts
// and a body hash. Names exist solely in the raw JSON under git-ignored scratch/, are read only to
// produce a boolean, and never enter a public table, a response or a log. The ten-digit refusal below
// is the ЕГН guard, and it is sound precisely because an ЕИК is 9 or 13 digits — never 10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openCache,
  upsertDeed,
  markOutsideTr,
  pendingEiks,
  readDeed,
  coverage,
  purgeExpired,
  RETENTION_DAYS,
} from './cache.mjs';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-cache-'));
  return { dir, file: path.join(dir, 'tr-cache.sqlite') };
}
const withCache = (fn) => {
  const { dir, file } = tmpDb();
  const db = openCache(file);
  try {
    return fn(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const deed = (over = {}) => ({
  eik: '115536179',
  httpStatus: 200,
  fetchedAt: '2026-08-05T10:00:00Z',
  rawPath: 'deeds/115536179.json',
  bodySha256: 'a'.repeat(64),
  legalFormCode: 4,
  legalFormVerdict: 'closely_held',
  seatNormalized: 'ПЛОВДИВ',
  seatEntryDate: '2014-01-23',
  latestOwnEntryDate: '2013-07-16',
  ...over,
});

test('openCache is idempotent — re-opening an existing cache preserves rows', () => {
  const { dir, file } = tmpDb();
  let db = openCache(file);
  upsertDeed(db, deed());
  db.close();
  db = openCache(file); // must not wipe
  assert.equal(readDeed(db, '115536179')?.eik, '115536179');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('upsertDeed replaces on re-fetch rather than duplicating', () =>
  withCache((db) => {
    upsertDeed(db, deed());
    upsertDeed(db, deed({ seatNormalized: 'СОФИЯ', fetchedAt: '2026-09-01T10:00:00Z' }));
    assert.equal(coverage(db, ['115536179']).fetched, 1);
    assert.equal(readDeed(db, '115536179').seatNormalized, 'СОФИЯ');
  }));

test('pendingEiks returns only what is not yet cached — this is what makes a run resumable', () =>
  withCache((db) => {
    upsertDeed(db, deed({ eik: '115536179' }));
    markOutsideTr(db, '204556676', 'BULSTAT association');
    const want = ['115536179', '204556676', '201122335', '203445566'];
    assert.deepEqual(pendingEiks(db, want).sort(), ['201122335', '203445566']);
  }));

test('a stale deed becomes pending again past the TTL, a fresh one does not', () =>
  withCache((db) => {
    upsertDeed(db, deed({ fetchedAt: '2026-01-01T00:00:00Z' })); // long past
    upsertDeed(db, deed({ eik: '201122335', fetchedAt: '2026-08-05T00:00:00Z' }));
    const now = new Date('2026-08-05T12:00:00Z');
    assert.deepEqual(pendingEiks(db, ['115536179', '201122335'], { maxAgeDays: 35, now }), [
      '115536179',
    ]);
  }));

test('coverage reports the fraction cached — the input to the fail-closed load gate', () =>
  withCache((db) => {
    upsertDeed(db, deed({ eik: '115536179' }));
    upsertDeed(db, deed({ eik: '201122335' }));
    markOutsideTr(db, '204556676', 'ДЗЗД');
    const c = coverage(db, ['115536179', '201122335', '204556676', '203445566']);
    assert.equal(c.wanted, 4);
    assert.equal(c.fetched, 2);
    assert.equal(c.outsideTr, 1);
    assert.equal(c.missing, 1);
    // „outside ТР" is a RESOLVED outcome, not a gap: it is known and permanent, so it counts as covered.
    assert.equal(c.covered, 3);
  }));

// ── the PII rail ──────────────────────────────────────────────────────────────
test('the index REFUSES a value carrying a ten-digit run (the ЕГН guard)', () =>
  withCache((db) => {
    // Sound because an ЕИК is 9 or 13 digits, never 10 — so this can never reject a legitimate code.
    assert.throws(
      () => upsertDeed(db, deed({ seatNormalized: 'СОФИЯ 8001014567' })),
      /ten-digit|ЕГН/i,
    );
    assert.throws(() => markOutsideTr(db, '204556676', 'подадено от 8001014567'), /ten-digit|ЕГН/i);
  }));

test('valid 9- and 13-digit codes are NOT caught by the ЕГН guard', () =>
  withCache((db) => {
    assert.doesNotThrow(() => upsertDeed(db, deed({ outsideReason: null })));
    assert.doesNotThrow(() => markOutsideTr(db, '1155361790001', 'клон'));
  }));

// A 13-digit ЕИК (клон/подразделение) CONTAINS ten-digit substrings, so an unanchored /\d{10}/
// rejects it — and rawPath on the fetched path is `<eik>.json`, derived from that very ЕИК. This is
// the exact shape fetch-deeds.mjs writes (path.relative(rawDir, deedPath(eik))), and upsertDeed sits
// past its JSON.parse/assertUicEcho try-catch, so a throw here aborts the whole crawl on the first
// branch office that returns a deed. The guard's own stated soundness ("an ЕИК is 9 or 13 digits,
// never 10") only holds if the run is matched as a WHOLE, which is why the pattern is anchored.
test('a 13-digit ЕИК does not trip the ЕГН guard through its own derived rawPath', () =>
  withCache((db) => {
    assert.doesNotThrow(() =>
      upsertDeed(db, deed({ eik: '1155361790001', rawPath: '1155361790001.json' })),
    );
    assert.equal(readDeed(db, '1155361790001').eik, '1155361790001');
  }));

// The rail must not be a hand-maintained allowlist of four field names: upsertDeed binds thirteen
// values, and the next one added would bypass the check silently. Every bound value is screened.
test('the ЕГН guard screens EVERY bound value, not a hand-picked subset', () =>
  withCache((db) => {
    for (const field of ['seatEntryDate', 'latestOwnEntryDate', 'fetchedAt'])
      assert.throws(() => upsertDeed(db, deed({ [field]: '8001014567' })), /ten-digit|ЕГН/i, field);
  }));

// ...with one exemption, and it is measured rather than assumed: a sha256 hex digest is 64 chars of
// [0-9a-f], so a standalone ten-digit run occurs in ~7% of hashes (18% unanchored). Screening it
// would refuse roughly one deed in fourteen for no privacy gain — a hash is not an ЕГН, and it is a
// hash precisely so that no deed content reaches the index.
test('the body hash is exempt from the ЕГН guard — a digit run there is arithmetic, not an ЕГН', () =>
  withCache((db) => {
    assert.doesNotThrow(() => upsertDeed(db, deed({ bodySha256: `8001014567${'a'.repeat(54)}` })));
  }));

test('the schema exposes no column that could hold a person name', () =>
  withCache((db) => {
    const cols = db
      .prepare(`SELECT name FROM pragma_table_info('deeds')`)
      .all()
      .map((r) => r.name);
    for (const forbidden of ['name', 'person', 'owner', 'manager', 'holder', 'full_name'])
      assert.ok(!cols.includes(forbidden), `deeds.${forbidden} must not exist (PII rail)`);
    // A hash, never an excerpt — an excerpt of a deed is third-party personal data.
    assert.ok(cols.includes('body_sha256'));
  }));

test('markOutsideTr is permanent-by-intent and records WHY', () =>
  withCache((db) => {
    markOutsideTr(db, '204556676', 'ДЗЗД — BULSTAT, not TR');
    const row = readDeed(db, '204556676');
    assert.equal(row.status, 'outside_tr');
    assert.match(row.outsideReason, /ДЗЗД/);
  }));

// ── retention (ADR-0033 decision 5) ───────────────────────────────────────────
// The ADR promises „a 35-day retention and a purge step in the same job". Freshness (pendingEiks'
// maxAgeDays) only makes a row pending again — it re-REQUESTS, it never deletes. Only this purge
// removes the third-party names in the raw deed, so these tests are the difference between a stated
// TTL and an enforced one.
function withRaw(fn) {
  const { dir, file } = tmpDb();
  const rawDir = path.join(dir, 'deeds');
  fs.mkdirSync(rawDir, { recursive: true });
  const db = openCache(file);
  try {
    return fn(db, rawDir);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const writeRaw = (rawDir, eik) =>
  fs.writeFileSync(path.join(rawDir, `${eik}.json`), '{"names":"third-party PII"}');

test('purgeExpired deletes the raw deed AND its row past the retention window', () =>
  withRaw((db, rawDir) => {
    const now = new Date('2026-08-05T00:00:00Z');
    upsertDeed(db, deed({ eik: '115536179', fetchedAt: '2026-05-01T00:00:00Z' })); // ~96 days old
    upsertDeed(db, deed({ eik: '201122335', fetchedAt: '2026-08-01T00:00:00Z' })); // 4 days old
    writeRaw(rawDir, '115536179');
    writeRaw(rawDir, '201122335');

    const res = purgeExpired(db, rawDir, { retentionDays: 35, now });
    assert.equal(res.rows, 1);
    assert.equal(res.files, 1);
    assert.equal(fs.existsSync(path.join(rawDir, '115536179.json')), false, 'PII must be gone');
    assert.equal(readDeed(db, '115536179'), null);
    // The in-window deed is untouched — a purge that also evicted live cache would force a re-crawl,
    // which is the one thing the pacing exists to avoid.
    assert.equal(fs.existsSync(path.join(rawDir, '201122335.json')), true);
    assert.ok(readDeed(db, '201122335'));
  }));

test('purgeExpired removes orphaned raw deeds — unreachable data is pure retained PII', () =>
  withRaw((db, rawDir) => {
    upsertDeed(db, deed({ eik: '115536179', fetchedAt: '2026-08-01T00:00:00Z' }));
    writeRaw(rawDir, '115536179');
    writeRaw(rawDir, '204556676'); // no index row: no read path can ever reach it
    const res = purgeExpired(db, rawDir, { now: new Date('2026-08-05T00:00:00Z') });
    assert.equal(res.orphans, 1);
    assert.equal(fs.existsSync(path.join(rawDir, '204556676.json')), false);
    assert.equal(fs.existsSync(path.join(rawDir, '115536179.json')), true);
  }));

test('purgeExpired defaults to the 35-day window and tolerates an already-missing file', () =>
  withRaw((db, rawDir) => {
    assert.equal(RETENTION_DAYS, 35);
    upsertDeed(db, deed({ eik: '115536179', fetchedAt: '2026-06-25T00:00:00Z' })); // 41 days
    upsertDeed(db, deed({ eik: '201122335', fetchedAt: '2026-07-15T00:00:00Z' })); // 21 days
    // No raw file on disk for the expired row: already gone is the goal state, not an error.
    const res = purgeExpired(db, rawDir, { now: new Date('2026-08-05T00:00:00Z') });
    assert.equal(res.rows, 1);
    assert.equal(res.files, 0);
    assert.ok(readDeed(db, '201122335'), 'the 21-day-old deed is inside the window');
  }));

test('purgeExpired tolerates an orphan that vanished under it, and keeps sweeping', () => {
  // The benign race: readdirSync lists a name, and it is gone by the time unlink runs (a concurrent
  // purge, an operator clearing scratch/). The expired loop right above has always tolerated this;
  // the orphan loop did not, and it throws AFTER the DB DELETE has committed — so the run half-purges,
  // reports "purge failed", and leaves the operator unable to tell "already gone" from "an orphan
  // still holding third-party names". Injected rather than staged, because the race cannot be timed
  // from a test; the injection seam matches the one httpGet/sleep/now already use in this codebase.
  return withRaw((db, rawDir) => {
    upsertDeed(db, deed({ eik: '115536179', fetchedAt: '2026-08-01T00:00:00Z' }));
    writeRaw(rawDir, '115536179');
    writeRaw(rawDir, '204556676'); // orphan 1 — disappears under us
    writeRaw(rawDir, '831391124'); // orphan 2 — must still be swept

    const seen = [];
    const res = purgeExpired(db, rawDir, {
      now: new Date('2026-08-05T00:00:00Z'),
      unlink: (p) => {
        seen.push(path.basename(p));
        if (p.endsWith('204556676.json')) {
          const err = new Error('ENOENT: no such file or directory');
          err.code = 'ENOENT';
          throw err;
        }
        fs.unlinkSync(p);
      },
    });

    assert.deepEqual(seen.sort(), ['204556676.json', '831391124.json'], 'both orphans attempted');
    assert.equal(
      res.orphans,
      1,
      'a file that was already gone was not deleted BY US — do not count it',
    );
    assert.equal(fs.existsSync(path.join(rawDir, '831391124.json')), false, 'the sweep continued');
    assert.equal(
      fs.existsSync(path.join(rawDir, '115536179.json')),
      true,
      'the live deed is untouched',
    );
  });
});

test('purgeExpired still refuses loudly on an orphan it could not delete for a REAL reason', () => {
  // The other half, and the reason the guard is ENOENT-only. A permission error means retained PII is
  // still on disk; reporting success would be the failure mode the purge exists to prevent.
  return withRaw((db, rawDir) => {
    writeRaw(rawDir, '204556676');
    assert.throws(
      () =>
        purgeExpired(db, rawDir, {
          now: new Date('2026-08-05T00:00:00Z'),
          unlink: () => {
            const err = new Error('EACCES: permission denied');
            err.code = 'EACCES';
            throw err;
          },
        }),
      /EACCES/,
    );
  });
});
