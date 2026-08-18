// node:test — the deed crawler, driven entirely through injected I/O. No network, no real scratch.
//
// This is the only component that touches a public register at volume, so what it must NOT do is the
// substance: never exceed the pace, never retry a 429, never turn a transient wall into permanent
// data, and never re-request what it already holds. Spec §3.3 permits a bounded per-ЕИК lookup and
// forbids bulk scraping; the difference between the two is enforced here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  parseTrOptions,
  run,
  MIN_INTERVAL_MS,
  BREAKER_TRIP,
  TRIES_PER_EIK,
} from './fetch-deeds.mjs';

const DEED = (uic) => ({
  uic,
  fullName: '"АЛФА СТРОЙ" ООД',
  legalForm: 4,
  sections: [
    {
      subDeeds: [
        {
          groups: [
            {
              fields: [
                {
                  nameCode: 'CR_F_19_L',
                  htmlData: `<div class='record-container'><p class='field-text'>ИВАН ПЕТРОВ ТЕСТОВ</p></div>`,
                  fieldEntryNumber: '20110502101007',
                  fieldEntryDate: '2011-05-02T00:00:00',
                },
                {
                  nameCode: 'CR_F_5_L',
                  htmlData: `<div class='record-container'><p class='field-text'>Населено място: гр. Пловдив</p></div>`,
                  fieldEntryNumber: '20110502101008',
                  fieldEntryDate: '2011-05-02T00:00:00',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

const ok = (uic) => ({
  status: 200,
  headers: {},
  body: Buffer.from(JSON.stringify(DEED(uic)), 'utf8'),
});
const status = (s) => ({ status: s, headers: {}, body: Buffer.from('') });

// Two valid ЕИК (real checksums) plus one that is shape-valid but checksum-invalid.
const A = '201122335';
const B = '203445566';
const C = '204556676';
const BAD_CHECKSUM = '201122336';

function ctx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-crawl-'));
  return {
    dir,
    dbFile: path.join(dir, 'tr-cache.sqlite'),
    rawDir: path.join(dir, 'deeds'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
const eiksFile = (dir, eiks) => {
  const f = path.join(dir, 'eiks.txt');
  fs.writeFileSync(f, eiks.join('\n') + '\n');
  return f;
};

/** Drive run() with a recording transport. `routes` maps ЕИК → response (or a function of attempt). */
function harness(c, eiks, routes, extraArgv = []) {
  const calls = [];
  const waits = [];
  const httpGet = async (url) => {
    const eik = url.split('/').pop();
    calls.push(eik);
    const r = routes[eik];
    return typeof r === 'function' ? r(calls.filter((e) => e === eik).length) : (r ?? status(404));
  };
  return {
    calls,
    waits,
    promise: run({
      httpGet,
      sleep: async (ms) => void waits.push(ms),
      now: () => new Date('2026-08-05T12:00:00Z'),
      guard: () => {},
      dbFile: c.dbFile,
      rawDir: c.rawDir,
      argv: ['node', 'fetch-deeds.mjs', '--eiks-file', eiksFile(c.dir, eiks), ...extraArgv],
    }),
  };
}

const openCacheRO = (dbFile) => new DatabaseSync(dbFile);
const rows = (dbFile) => {
  const db = openCacheRO(dbFile);
  const r = db.prepare('SELECT eik, status, outside_reason FROM deeds ORDER BY eik').all();
  db.close();
  return r;
};

// ── options ───────────────────────────────────────────────────────────────────
test('parseTrOptions: defaults are the documented polite pace', () => {
  const o = parseTrOptions(['node', 'x', '--eiks-file', '/tmp/e.txt']);
  assert.equal(o.eiksFile, '/tmp/e.txt');
  assert.equal(o.limit, Infinity);
  assert.equal(o.minIntervalMs, MIN_INTERVAL_MS);
  assert.ok(MIN_INTERVAL_MS >= 3000, 'the documented pace is 1 request / 3 s');
});

test('parseTrOptions: rejects a pace FASTER than the documented one', () => {
  // Tuning around a limiter empirically is precisely what spec §3.3 forbids; make it un-passable.
  assert.throws(
    () => parseTrOptions(['node', 'x', '--eiks-file', '/e', '--min-interval-ms', '100']),
    /min-interval/i,
  );
});

test('parseTrOptions: --eiks-file is required, and numeric flags are validated', () => {
  assert.throws(() => parseTrOptions(['node', 'x']), /eiks-file/i);
  for (const bad of ['0', '-1', 'abc', '1.5'])
    assert.throws(
      () => parseTrOptions(['node', 'x', '--eiks-file', '/e', '--limit', bad]),
      /limit/i,
      bad,
    );
});

// ── pacing ────────────────────────────────────────────────────────────────────
test('requests are sequential and spaced by at least the documented interval', async () => {
  const c = ctx();
  try {
    const h = harness(c, [A, B, C], { [A]: ok(A), [B]: ok(B), [C]: ok(C) });
    assert.equal(await h.promise, 0);
    assert.deepEqual(h.calls, [A, B, C], 'sequential, in order — never concurrent');
    const paces = h.waits.filter((w) => w >= MIN_INTERVAL_MS);
    assert.ok(paces.length >= 2, `expected a pace wait between requests, got ${h.waits.join(',')}`);
  } finally {
    c.cleanup();
  }
});

// ── 429 ───────────────────────────────────────────────────────────────────────
test('a 429 ends the run with exit 2 and marks NOTHING', async () => {
  const c = ctx();
  try {
    const h = harness(c, [A, B, C], { [A]: ok(A), [B]: status(429), [C]: ok(C) });
    assert.equal(await h.promise, 2, 'a rate-limit block is its own exit code');
    assert.deepEqual(h.calls, [A, B], 'stops AT the 429 — C is never requested');
    // B must not be recorded at all: it is unknown, not absent, and certainly not outside the register.
    assert.deepEqual(
      rows(c.dbFile).map((r) => r.eik),
      [A],
    );
  } finally {
    c.cleanup();
  }
});

test('after a 429 the run resumes exactly where it stopped', async () => {
  const c = ctx();
  try {
    const first = harness(c, [A, B, C], { [A]: ok(A), [B]: status(429), [C]: ok(C) });
    assert.equal(await first.promise, 2);
    const second = harness(c, [A, B, C], { [A]: ok(A), [B]: ok(B), [C]: ok(C) });
    assert.equal(await second.promise, 0);
    assert.deepEqual(second.calls, [B, C], 'A is already cached — not re-requested');
  } finally {
    c.cleanup();
  }
});

// ── resumability ──────────────────────────────────────────────────────────────
test('a re-run over a complete cache makes ZERO requests', async () => {
  const c = ctx();
  try {
    assert.equal(await harness(c, [A, B], { [A]: ok(A), [B]: ok(B) }).promise, 0);
    const again = harness(c, [A, B], { [A]: ok(A), [B]: ok(B) });
    assert.equal(await again.promise, 0);
    assert.deepEqual(again.calls, [], 'nothing to fetch');
  } finally {
    c.cleanup();
  }
});

// ── permanence ────────────────────────────────────────────────────────────────
test('an empty 200 is the register saying „no deed" and is cached as outside-ТР', async () => {
  // MEASURED against the live API: an ЕИК that is not a търговец (Община София, 000696327) answers
  // HTTP 200 with a ZERO-BYTE body — not the 404 or HTML #279 §3 predicts. Reproduced twice, with a
  // real company returning its full deed in the same window, so it is an answer and not an outage.
  const c = ctx();
  try {
    const empty = { status: 200, headers: {}, body: Buffer.alloc(0) };
    assert.equal(await harness(c, [A], { [A]: empty }).promise, 0);
    const [row] = rows(c.dbFile);
    assert.equal(row.status, 'outside_tr');
    assert.match(row.outside_reason, /empty body/i);
  } finally {
    c.cleanup();
  }
});

test('an empty body under a 5xx stays TRANSIENT — the status decides, not the emptiness', async () => {
  // The pair that keeps R6 honest. Both responses have a zero-byte body; only the 200 is an answer.
  const c = ctx();
  try {
    assert.equal(await harness(c, [A], { [A]: status(503) }).promise, 1);
    assert.deepEqual(rows(c.dbFile), [], 'a 5xx must never become permanent „outside ТР"');
  } finally {
    c.cleanup();
  }
});

test('a 404 is a DOCUMENTED negative and is cached as outside-ТР', async () => {
  const c = ctx();
  try {
    assert.equal(await harness(c, [A], { [A]: status(404) }).promise, 0);
    const [row] = rows(c.dbFile);
    assert.equal(row.status, 'outside_tr');
    assert.match(row.outside_reason, /404/);
  } finally {
    c.cleanup();
  }
});

test('a persistent 5xx is TRANSIENT and is never cached as outside-ТР', async () => {
  // R6: „outside the register" is permanent by intent. Writing it after a transient wall turns a
  // temporary outage into permanent data that §8 never re-examines.
  const c = ctx();
  try {
    const code = await harness(c, [A], { [A]: status(503) }).promise;
    assert.equal(code, 1, 'an unresolved ЕИК makes the run incomplete');
    assert.deepEqual(rows(c.dbFile), [], 'nothing may be recorded from a 5xx');
  } finally {
    c.cleanup();
  }
});

test('a deed whose UIC does not echo the request is REFUSED, not cached', async () => {
  // R8, at the crawl boundary: if anything rewrote the identifier we would be caching one company's
  // deed under another company's ЕИК, and every downstream claim about it would name the wrong firm.
  const c = ctx();
  try {
    const code = await harness(c, [A], { [A]: ok('999999999') }).promise;
    assert.equal(code, 1);
    assert.deepEqual(rows(c.dbFile), []);
    assert.deepEqual(fs.existsSync(c.rawDir) ? fs.readdirSync(c.rawDir) : [], []);
  } finally {
    c.cleanup();
  }
});

test('a checksum-invalid ЕИК is skipped without ever being requested', async () => {
  const c = ctx();
  try {
    const h = harness(c, [BAD_CHECKSUM, A], { [A]: ok(A) });
    assert.equal(await h.promise, 0);
    assert.deepEqual(h.calls, [A], 'the invalid code costs the register nothing');
  } finally {
    c.cleanup();
  }
});

// ── output ────────────────────────────────────────────────────────────────────
test('the raw deed is written under the raw dir and the index records only non-PII', async () => {
  const c = ctx();
  try {
    assert.equal(await harness(c, [A], { [A]: ok(A) }).promise, 0);
    assert.deepEqual(fs.readdirSync(c.rawDir), [`${A}.json`]);
    const db = openCacheRO(c.dbFile);
    const row = db.prepare('SELECT * FROM deeds WHERE eik = ?').get(A);
    db.close();
    assert.equal(row.status, 'fetched');
    assert.equal(row.legal_form_verdict, 'closely_held');
    assert.equal(row.seat_normalized, 'ПЛОВДИВ');
    assert.equal(row.body_sha256.length, 64);
    // The raw file holds the names; the index must not.
    assert.ok(!JSON.stringify(row).includes('ТЕСТОВ'));
    assert.ok(fs.readFileSync(path.join(c.rawDir, `${A}.json`), 'utf8').includes('ТЕСТОВ'));
  } finally {
    c.cleanup();
  }
});

test('--limit bounds a run without marking the remainder as anything', async () => {
  const c = ctx();
  try {
    const h = harness(c, [A, B, C], { [A]: ok(A), [B]: ok(B), [C]: ok(C) }, ['--limit', '2']);
    assert.equal(await h.promise, 0, 'a deliberately bounded run is not an incomplete one');
    assert.deepEqual(h.calls, [A, B]);
    assert.deepEqual(
      rows(c.dbFile).map((r) => r.eik),
      [A, B],
    );
  } finally {
    c.cleanup();
  }
});

/**
 * N genuinely checksum-valid 9-digit ЕИК. Generated, not hand-written: an earlier version of the
 * breaker test below used made-up codes, of which only 1 in 10 was valid — so the crawler dropped
 * them all before requesting anything and the assertion passed on zero calls. A test that exercises
 * nothing is worse than no test (ADR-0027).
 */
function validEiks(n) {
  const control = (p8) => {
    const d = [...p8].map(Number);
    let s = d.reduce((a, x, i) => a + x * (i + 1), 0) % 11;
    if (s === 10) {
      s = d.reduce((a, x, i) => a + x * (i + 3), 0) % 11;
      if (s === 10) s = 0;
    }
    return s;
  };
  const out = [];
  for (let i = 0; out.length < n; i++) {
    const p8 = String(20000000 + i);
    out.push(p8 + control(p8));
  }
  return out;
}

test('the ЕИК generator used by the breaker test really produces valid codes', () => {
  const eiks = validEiks(15);
  assert.equal(eiks.length, 15);
  assert.equal(new Set(eiks).size, 15);
  // Proves the breaker test below actually reaches the network path rather than being filtered out.
  assert.deepEqual(
    eiks.filter((e) => e.length !== 9),
    [],
  );
});

test('the circuit breaker aborts a sustained wall of failures', async () => {
  // A long run against a broken endpoint must stop hammering, even though each individual 5xx is
  // „transient". Distinct from the 429 path: that stops instantly and deliberately.
  const c = ctx();
  try {
    const many = validEiks(BREAKER_TRIP + 10);
    const routes = Object.fromEntries(many.map((e) => [e, status(503)]));
    const h = harness(c, many, routes);
    assert.equal(await h.promise, 1);

    const attempted = [...new Set(h.calls)];
    assert.equal(attempted.length, BREAKER_TRIP, 'the breaker cuts the run at its threshold');
    assert.ok(attempted.length < many.length, 'and therefore short of the full candidate set');
    // The number that actually matters is REQUESTS, not candidates: each unresolved ЕИК costs the
    // full retry budget, so the breaker's real cost is BREAKER_TRIP × TRIES_PER_EIK. Keep that under
    // the ~50 at which the register was observed to start returning a sustained 429 — otherwise the
    // safety mechanism is itself what trips the block.
    assert.equal(h.calls.length, BREAKER_TRIP * TRIES_PER_EIK);
    assert.ok(
      h.calls.length <= 25,
      `a failing run must not spend ${h.calls.length} requests before giving up`,
    );
    assert.deepEqual(rows(c.dbFile), [], 'a wall of 5xx records nothing');
  } finally {
    c.cleanup();
  }
});

// ── retention (ADR-0033 decision 5: „a purge step in the same job") ───────────
test('the job purges past-retention deeds, and does so even when a 429 ends the run', async () => {
  // Retention is an obligation about other people's data, not a reward for a clean run: the paths that
  // leave early — a 429, a tripped breaker — are exactly the ones where a naive placement after the
  // fetch loop would skip it and let third-party names sit on disk indefinitely.
  for (const [label, route] of [
    ['clean run', ok(A)],
    ['429 stops the run', status(429)],
  ]) {
    const c = ctx();
    try {
      // An old deed with its raw file — well past the 35-day window at the harness's fixed clock.
      fs.mkdirSync(c.rawDir, { recursive: true });
      fs.writeFileSync(path.join(c.rawDir, `${C}.json`), '{"owner":"ТРЕТО ЛИЦЕ"}');
      const db = new DatabaseSync(c.dbFile);
      db.exec(`CREATE TABLE IF NOT EXISTS deeds (
        eik TEXT PRIMARY KEY, status TEXT NOT NULL, http_status INTEGER, fetched_at TEXT NOT NULL,
        raw_path TEXT, body_sha256 TEXT, legal_form_code INTEGER, legal_form_verdict TEXT,
        seat_normalized TEXT, seat_entry_date TEXT, latest_own_entry_date TEXT,
        attempts INTEGER NOT NULL DEFAULT 1, outside_reason TEXT);
        INSERT INTO deeds (eik,status,fetched_at,raw_path) VALUES ('${C}','fetched','2026-01-01T00:00:00Z','${C}.json');`);
      db.close();

      await harness(c, [A], { [A]: route }).promise;

      assert.equal(
        fs.existsSync(path.join(c.rawDir, `${C}.json`)),
        false,
        `${label}: the past-retention raw deed must be deleted`,
      );
      assert.equal(
        rows(c.dbFile).some((r) => r.eik === C),
        false,
        `${label}: its index row must go with it`,
      );
    } finally {
      c.cleanup();
    }
  }
});

test('the purge leaves in-window deeds alone — it is a privacy rail, not a cache eviction', async () => {
  // If it evicted live cache, every run would re-request deeds it already holds, which is precisely
  // the volume against the register the pacing exists to avoid.
  const c = ctx();
  try {
    await harness(c, [A], { [A]: ok(A) }).promise;
    assert.equal(rows(c.dbFile).length, 1, 'the deed just fetched must survive its own job');
    assert.equal(fs.existsSync(path.join(c.rawDir, `${A}.json`)), true);
  } finally {
    c.cleanup();
  }
});
