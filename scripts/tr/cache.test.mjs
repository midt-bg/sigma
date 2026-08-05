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
import { openCache, upsertDeed, markOutsideTr, pendingEiks, readDeed, coverage } from './cache.mjs';

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
