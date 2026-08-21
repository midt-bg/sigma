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
  readLinksFile,
  run,
  MIN_INTERVAL_MS,
  BREAKER_TRIP,
  TRIES_PER_EIK,
  RATE_LIMIT_COOLDOWN_MS,
  MAX_COOLDOWNS,
} from './fetch-deeds.mjs';
import { VERDICT_RETENTION_DAYS } from './cache.mjs';

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
function harness(c, eiks, routes, extraArgv = [], now = () => new Date('2026-08-05T12:00:00Z')) {
  const calls = [];
  const waits = [];
  const httpGet = async (url) => {
    const eik = url.split('/').pop();
    calls.push(eik);
    const r = routes[eik];
    if (typeof r === 'function') return r(calls.filter((e) => e === eik).length);
    if (r instanceof Error) throw r;
    return r ?? status(404);
  };
  return {
    calls,
    waits,
    promise: run({
      httpGet,
      sleep: async (ms) => void waits.push(ms),
      now,
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

test('parseTrOptions: --max-runtime-min is absent by default and parses to milliseconds', () => {
  const base = ['node', 'x', '--eiks-file', '/tmp/e.txt'];
  assert.equal(parseTrOptions(base).maxRuntimeMs, Infinity, 'no ceiling unless asked for');
  assert.equal(parseTrOptions([...base, '--max-runtime-min', '90']).maxRuntimeMs, 90 * 60_000);
  for (const bad of ['0', '-5', 'abc', '1.5'])
    assert.throws(
      () => parseTrOptions([...base, '--max-runtime-min', bad]),
      /max-runtime-min/i,
      bad,
    );
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

test('the cooldown constants are pinned to the measurement, not merely imported', () => {
  // Every other assertion in this file follows the imported constant, so 3→1 and 3→100 both passed the
  // whole suite — the budget was tautological. Pin the VALUES, the way MIN_INTERVAL_MS already is.
  assert.equal(
    MAX_COOLDOWNS,
    3,
    'three cooldowns before giving up; changing this changes the deal',
  );
  assert.ok(
    RATE_LIMIT_COOLDOWN_MS >= 161_000,
    `the cooldown must cover the ~161s recovery measured in ADR-0036, got ${RATE_LIMIT_COOLDOWN_MS}`,
  );
  assert.ok(
    RATE_LIMIT_COOLDOWN_MS <= 600_000,
    'and must not be so long a run spends itself waiting',
  );
});

// ── 429 is a cooldown (ADR-0036) ──────────────────────────────────────────────
test('a 429 that clears is a cooldown, not a stop: the SAME ЕИК is re-requested', async () => {
  const c = ctx();
  try {
    // B answers 429 once, then normally — the rhythm ADR-0036 measured (~161s and it clears).
    const h = harness(c, [A, B, C], {
      [A]: ok(A),
      [B]: (attempt) => (attempt === 1 ? status(429) : ok(B)),
      [C]: ok(C),
    });
    assert.equal(await h.promise, 0, 'a cleared block is not a failed run');
    assert.deepEqual(
      h.calls,
      [A, B, B, C],
      'B is retried after the cooldown, and C is still reached',
    );
    assert.equal(
      h.waits.filter((w) => w === RATE_LIMIT_COOLDOWN_MS).length,
      1,
      'exactly one cooldown was waited out',
    );
    assert.deepEqual(
      rows(c.dbFile).map((r) => r.eik),
      [A, B, C].sort(),
    );
  } finally {
    c.cleanup();
  }
});

test('a block outlasting every cooldown ends the run with exit 2 and marks NOTHING', async () => {
  const c = ctx();
  try {
    const h = harness(c, [A, B, C], { [A]: ok(A), [B]: status(429), [C]: ok(C) });
    assert.equal(await h.promise, 2, 'a sustained block keeps its own exit code');
    // One initial attempt plus one per cooldown, then give up. C is never requested: the run stops,
    // it does not skip past the block and keep spending the register's budget.
    assert.deepEqual(h.calls, [A, ...Array(MAX_COOLDOWNS + 1).fill(B)]);
    assert.equal(h.waits.filter((w) => w === RATE_LIMIT_COOLDOWN_MS).length, MAX_COOLDOWNS);
    // B must not be recorded at all: it is unknown, not absent, and certainly not outside the register.
    assert.deepEqual(
      rows(c.dbFile).map((r) => r.eik),
      [A],
    );
  } finally {
    c.cleanup();
  }
});

test('a STALL during a cooldown is the block talking, not five fresh attempts', async () => {
  const c = ctx();
  try {
    // The block's second face (ADR-0036): once cooling down, the connection hangs instead of
    // answering 429. Without the tries=1 narrowing each of those would cost TRIES_PER_EIK attempts.
    const h = harness(c, [A, B], {
      [A]: ok(A),
      [B]: (attempt) => {
        if (attempt === 1) return status(429);
        throw new Error('timeout after 20000ms');
      },
    });
    assert.equal(await h.promise, 2);
    const bCalls = h.calls.filter((e) => e === B).length;
    assert.equal(
      bCalls,
      MAX_COOLDOWNS + 1,
      `one attempt per cooldown, not ${TRIES_PER_EIK} — got ${bCalls}`,
    );
    assert.ok(
      bCalls < 1 + MAX_COOLDOWNS * TRIES_PER_EIK,
      'a stall must not be fed the full retry budget',
    );
  } finally {
    c.cleanup();
  }
});

test('the cooldown counter resets on success, so a slow crawl never trips it', async () => {
  const c = ctx();
  try {
    // Every ЕИК meets the limiter once. That is the ordinary rhythm at 5-per-window, and it must not
    // accumulate into an exit 2 — the counter is CONSECUTIVE cooldowns without a success.
    const once = (eik) => (attempt) => (attempt === 1 ? status(429) : ok(eik));
    const h = harness(c, [A, B, C], { [A]: once(A), [B]: once(B), [C]: once(C) });
    assert.equal(await h.promise, 0);
    assert.equal(
      h.waits.filter((w) => w === RATE_LIMIT_COOLDOWN_MS).length,
      3,
      'one each, no give-up',
    );
    assert.equal(rows(c.dbFile).length, 3);
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

// ── links mode: the crawl decides (ADR-0037) ──────────────────────────────────

/** A deed naming BOTH the declarant and a co-owner who holds no public office. */
const DEED_WITH_COOWNER = (uic) => ({
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
                  htmlData:
                    `<div class='record-container'><p class='field-text'>ИВАН ПЕТРОВ ТЕСТОВ</p></div>` +
                    `<div class='record-container'><p class='field-text'>МАРИЯ ГЕОРГИЕВА СЪДРУЖНИК</p></div>`,
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
const okCoowner = (uic) => ({
  status: 200,
  headers: {},
  body: Buffer.from(JSON.stringify(DEED_WITH_COOWNER(uic)), 'utf8'),
});

const linksFileFor = (dir, records) => {
  const f = path.join(dir, 'links.jsonl');
  fs.writeFileSync(f, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
};
const linkRec = (eik, over = {}) => ({
  linkKey: `person:ИВАН|МВР|${eik}`,
  eik,
  declarantName: 'ИВАН ПЕТРОВ ТЕСТОВ',
  declaredSeats: ['Пловдив'],
  declaredEik: false,
  firstDeclaredYear: 2019,
  scope: 'self',
  nameGloballyUnique: true,
  companyNameDistinctive: true,
  ...over,
});
/** Drive run() in links mode. Mirrors `harness`, but the closed set carries the decision inputs. */
function linksHarness(c, records, routes, extraArgv = []) {
  const calls = [];
  const waits = [];
  return {
    calls,
    waits,
    promise: run({
      httpGet: async (url) => {
        const eik = url.split('/').pop();
        calls.push(eik);
        const r = routes[eik];
        if (typeof r === 'function') return r(calls.filter((e) => e === eik).length);
        return r ?? status(404);
      },
      sleep: async (ms) => void waits.push(ms),
      now: () => new Date('2026-08-19T12:00:00Z'),
      guard: () => {},
      dbFile: c.dbFile,
      rawDir: c.rawDir,
      argv: ['node', 'x', '--links-file', linksFileFor(c.dir, records), ...extraArgv],
    }),
  };
}
const verdictRows = (dbFile) => {
  const db = openCacheRO(dbFile);
  const r = db.prepare('SELECT * FROM verdicts ORDER BY link_key').all();
  db.close();
  return r;
};

test('parseTrOptions: exactly one closed set, and they are not interchangeable', () => {
  assert.throws(() => parseTrOptions(['node', 'x']), /links-file.*eiks-file/i);
  assert.throws(
    () => parseTrOptions(['node', 'x', '--eiks-file', '/e', '--links-file', '/l']),
    /mutually exclusive/i,
  );
  assert.equal(parseTrOptions(['node', 'x', '--links-file', '/l']).linksFile, '/l');
});

test('readLinksFile hashes each record from the SAME object the decision will use', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-links-'));
  try {
    const f = linksFileFor(dir, [linkRec(A), linkRec(B)]);
    const links = readLinksFile(f);
    assert.equal(links.length, 2);
    assert.ok(!('linkKey' in links[0].input), 'the routing keys are not decision inputs');
    assert.ok(!('eik' in links[0].input), 'nor is the company — the deed answers for that');
    // Same declaration inputs on two different companies hash the same, and that is correct: the hash
    // is only ever compared against the verdict stored under the SAME link_key.
    assert.equal(links[0].inputsHash, links[1].inputsHash);
    const [moved] = readLinksFile(linksFileFor(dir, [linkRec(A, { declaredSeats: ['Варна'] })]));
    assert.notEqual(moved.inputsHash, links[0].inputsHash, 'a changed input moves the hash');
    fs.writeFileSync(f, '{"eik":"201122335"}\n');
    assert.throws(() => readLinksFile(f), /linkKey/);
    fs.writeFileSync(f, 'not json\n');
    assert.throws(() => readLinksFile(f), /not JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('links mode decides every link and caches the verdict, not the deed', async () => {
  const c = ctx();
  try {
    const h = linksHarness(c, [linkRec(A)], { [A]: ok(A) });
    assert.equal(await h.promise, 0);
    const [v] = verdictRows(c.dbFile);
    assert.equal(v.link_key, `person:ИВАН|МВР|${A}`);
    assert.equal(v.eik, A);
    assert.ok(v.kind, 'a decision was reached');
    assert.ok(v.decided_at && v.inputs_hash && v.rules_version);
    // The deed served its purpose and left with it.
    assert.ok(!fs.existsSync(path.join(c.rawDir, `${A}.json`)), 'the raw deed is dropped at once');
  } finally {
    c.cleanup();
  }
});

test('NO third-party name reaches the verdict row — the whole licence for caching it', async () => {
  const c = ctx();
  try {
    // МАРИЯ ГЕОРГИЕВА СЪДРУЖНИК holds no public office. She appears in the deed and must appear
    // nowhere that outlives the runner. ADR-0037 rests on this being true, so it is asserted rather
    // than argued: every column of every row, against the whole cache file for good measure.
    const h = linksHarness(c, [linkRec(A)], { [A]: okCoowner(A) });
    assert.equal(await h.promise, 0);
    const rows_ = verdictRows(c.dbFile);
    // Pinned so the proof cannot quietly become vacuous: a run that degraded to a null „unknown"
    // verdict would satisfy every assertion below while proving nothing at all.
    assert.equal(rows_.length, 1);
    assert.equal(rows_[0].kind, 'document');
    assert.equal(rows_[0].publishable, 1);
    assert.equal(rows_[0].registry_role, 'owner', 'a role IS stored — that is the claim');
    assert.equal(rows_[0].entry_number, '20110502101007');
    for (const row of rows_)
      for (const [col, val] of Object.entries(row))
        assert.ok(
          !String(val ?? '').includes('СЪДРУЖНИК'),
          `verdicts.${col} carries a co-owner's name: ${val}`,
        );
    const blob = fs.readFileSync(c.dbFile);
    assert.ok(!blob.includes(Buffer.from('СЪДРУЖНИК', 'utf8')), 'nor anywhere else in the cache');
  } finally {
    c.cleanup();
  }
});

test('an outside-ТР answer is a decision too, so the next run does not re-ask', async () => {
  const c = ctx();
  try {
    const first = linksHarness(c, [linkRec(A)], { [A]: status(404) });
    assert.equal(await first.promise, 0);
    assert.equal(verdictRows(c.dbFile)[0].kind, 'outside_tr');
    assert.equal(verdictRows(c.dbFile)[0].publishable, 0, 'held, never published');
    const second = linksHarness(c, [linkRec(A)], { [A]: status(404) });
    assert.equal(await second.promise, 0);
    assert.deepEqual(second.calls, [], 'already answered');
  } finally {
    c.cleanup();
  }
});

test('a complete verdict cache costs zero requests; a changed declaration re-pends its ЕИК', async () => {
  const c = ctx();
  try {
    assert.equal(
      await linksHarness(c, [linkRec(A), linkRec(B)], { [A]: ok(A), [B]: ok(B) }).promise,
      0,
    );
    const again = linksHarness(c, [linkRec(A), linkRec(B)], { [A]: ok(A), [B]: ok(B) });
    assert.equal(await again.promise, 0);
    assert.deepEqual(again.calls, [], 'nothing left to decide');

    // The deed is untouched and fresh — it is the DECLARATION that moved, and deed freshness alone
    // would have skipped this company entirely.
    const moved = linksHarness(c, [linkRec(A, { declaredSeats: ['Варна'] }), linkRec(B)], {
      [A]: ok(A),
      [B]: ok(B),
    });
    assert.equal(await moved.promise, 0);
    assert.deepEqual(moved.calls, [A], 'only the link whose inputs changed is re-decided');
  } finally {
    c.cleanup();
  }
});

test('two links on ONE company are both decided from a single request', async () => {
  const c = ctx();
  try {
    const recs = [
      linkRec(A, { linkKey: `person:ИВАН|МВР|${A}` }),
      linkRec(A, { linkKey: `person:ИВАН|МОН|${A}` }),
    ];
    const h = linksHarness(c, recs, { [A]: ok(A) });
    assert.equal(await h.promise, 0);
    assert.deepEqual(h.calls, [A], 'one company, one request');
    assert.equal(verdictRows(c.dbFile).length, 2, 'both links decided');
  } finally {
    c.cleanup();
  }
});

test('an undecidable link is held, and does NOT fail the run for every other link', async () => {
  const c = ctx();
  try {
    // The deed is perfectly readable; it is THIS LINK's declaration side that is unusable
    // (`declaredSeats` is not a list, so the ladder throws on it). That is the case H3 is about: the
    // ЕИК was reached, its deed indexed, and one link cannot be reasoned about. Folding that into
    // `unresolved` made it exit 1 → the workflow stop before load.mjs → the same failure every run,
    // for ever, with no operator escape.
    const bad = linkRec(B, { linkKey: `person:ИВАН|СЧУПЕН|${B}`, declaredSeats: 'София' });
    const h = linksHarness(c, [linkRec(A), bad], { [A]: ok(A), [B]: ok(B) });
    assert.equal(await h.promise, 0, 'one undecidable link must not fail the whole run');
    assert.deepEqual(
      verdictRows(c.dbFile).map((r) => r.eik),
      [A],
      'the readable link is decided; the other is simply held',
    );

    // And it re-pends rather than caching a fabricated hold, so a corrected record is picked up next
    // run. A verdict invented here would be a hold nothing ever revisits.
    const again = linksHarness(c, [linkRec(A), bad], { [A]: ok(A), [B]: ok(B) });
    assert.equal(await again.promise, 0);
    assert.deepEqual(again.calls, [B], 'only the undecided one is re-asked');
  } finally {
    c.cleanup();
  }
});

test('in links mode the raw deed never reaches the disk at all', async () => {
  const c = ctx();
  try {
    // Not „written then deleted": never written. A crash between the write and the delete used to
    // leave a deed on disk under a fresh verdict — skipped by the next run, invisible to the purge,
    // and full of third-party names for the whole retention window.
    const seen = [];
    const h = linksHarness(c, [linkRec(A)], {
      [A]: () => {
        // Sampled DURING the run, between the response and the decision.
        seen.push(fs.existsSync(path.join(c.rawDir, `${A}.json`)));
        return ok(A);
      },
    });
    assert.equal(await h.promise, 0);
    assert.deepEqual(seen, [false]);
    assert.ok(!fs.existsSync(path.join(c.rawDir, `${A}.json`)), 'and none after');
    const [row] = verdictRows(c.dbFile);
    assert.ok(row, 'the verdict is still stored — the deed was simply never needed on disk');
  } finally {
    c.cleanup();
  }
});

// ── runtime budget ────────────────────────────────────────────────────────────
test('the runtime budget stops the run cleanly, leaving the rest for the next one', async () => {
  const c = ctx();
  const routes = { [A]: ok(A), [B]: ok(B), [C]: ok(C) };
  // A clock that advances a minute per read. The exact call count is an implementation detail, so the
  // control run below — same routes, same clock, no budget — is what makes this a real assertion.
  const ticking = () => {
    let t = Date.parse('2026-08-05T12:00:00Z');
    return () => new Date((t += 60_000));
  };
  try {
    const bounded = harness(c, [A, B, C], routes, ['--max-runtime-min', '2'], ticking());
    assert.equal(await bounded.promise, 0, 'running out of time is not a failure');
    assert.ok(
      bounded.calls.length < 3,
      `expected the budget to stop the run early, got ${bounded.calls.length} requests`,
    );
    // Whatever it did reach is cached — that is the whole licence for stopping early.
    assert.deepEqual(
      rows(c.dbFile).map((r) => r.eik),
      bounded.calls.slice().sort(),
    );
  } finally {
    c.cleanup();
  }

  const c2 = ctx();
  try {
    const control = harness(c2, [A, B, C], routes, [], ticking());
    assert.equal(await control.promise, 0);
    assert.equal(
      control.calls.length,
      3,
      'without the budget the same clock reaches every candidate',
    );
  } finally {
    c2.cleanup();
  }
});

test('a candidate we asked about and could not resolve still fails the run, budget or not', async () => {
  const c = ctx();
  try {
    // „Ran out of time" must not launder a real failure into a green run: B was ATTEMPTED and lost.
    const h = harness(c, [A, B], { [A]: ok(A), [B]: status(500) }, ['--max-runtime-min', '600']);
    assert.equal(await h.promise, 1);
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
test('an empty 200 becomes „outside ТР" only on the SECOND observation', async () => {
  // MEASURED against the live API: an ЕИК that is not a търговец (Община София, 000696327) answers
  // HTTP 200 with a ZERO-BYTE body — not the 404 or HTML #279 §3 predicts. Reproduced TWICE, with a
  // real company returning its full deed in the same window, so it is an answer and not an outage.
  // „Twice" is the evidence, so twice is what the code now requires: a single anomalous empty 200 —
  // from an edge of the sort that already answers our 429s with zero bytes — must not become a
  // 30-day negative for a real company.
  const c = ctx();
  try {
    const empty = { status: 200, headers: {}, body: Buffer.alloc(0) };
    assert.equal(await harness(c, [A], { [A]: empty }).promise, 0);
    assert.equal(rows(c.dbFile)[0].status, 'outside_tr_pending', 'one look is not an answer');

    // Provisional leaves the ЕИК pending, so the next run re-asks it — in place of the refresh it
    // would have spent anyway, which is why the second look costs nothing in the steady state.
    const second = harness(c, [A], { [A]: empty });
    assert.equal(await second.promise, 0);
    assert.deepEqual(
      second.calls,
      [A],
      'a provisional negative is re-asked, not treated as settled',
    );
    const [row] = rows(c.dbFile);
    assert.equal(row.status, 'outside_tr');
    assert.match(row.outside_reason, /empty body/i);
  } finally {
    c.cleanup();
  }
});

test('a 404 is permanent on ONE observation — it says „not here" on its own', async () => {
  const c = ctx();
  try {
    assert.equal(await harness(c, [A], { [A]: status(404) }).promise, 0);
    assert.equal(rows(c.dbFile)[0].status, 'outside_tr');
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

// ── convergence (ADR-0037) ────────────────────────────────────────────────────
// The property the whole incremental design rests on, and the one whose absence let a version ship
// that could never publish: with a per-run budget smaller than the candidate set, repeated runs must
// still reach FULL coverage — and keep it as verdicts age out. That needs two things working
// together, so both are asserted here rather than argued in an ADR:
//   • a queue ordered by staleness, so a bounded run drains a rotating set and never re-serves one
//     prefix while the tail starves;
//   • a refresh window that comes round faster than the retention window empties it.

// Rotation itself — oldest-first when the whole set goes stale together — is pinned at the unit level
// in cache.test.mjs, where a lexicographic implementation actually fails. On a cold cache every ЕИК is
// equally undecided, so this one proves the weaker but still necessary property: consecutive bounded
// runs make PROGRESS rather than re-serving what they already decided.
test('consecutive budget-bounded runs make progress instead of re-serving the same ЕИК', async () => {
  const c = ctx();
  try {
    const eiks = validEiks(9);
    const recs = eiks.map((e) => linkRec(e));
    const routes = Object.fromEntries(eiks.map((e) => [e, ok(e)]));
    const first = linksHarness(c, recs, routes, ['--limit', '3']);
    assert.equal(await first.promise, 0);
    const second = linksHarness(c, recs, routes, ['--limit', '3']);
    assert.equal(await second.promise, 0);

    assert.equal(first.calls.length, 3);
    assert.equal(second.calls.length, 3);
    assert.deepEqual(
      first.calls.filter((e) => second.calls.includes(e)),
      [],
      'sorted by ЕИК this would re-serve the same prefix for ever and the tail would never decide',
    );
  } finally {
    c.cleanup();
  }
});

test('repeated bounded runs converge to FULL coverage, and hold it', async () => {
  const c = ctx();
  try {
    const eiks = validEiks(9);
    const recs = eiks.map((e) => linkRec(e));
    const routes = Object.fromEntries(eiks.map((e) => [e, ok(e)]));
    const BUDGET = 2;

    // Ceiling of 9/2, plus one run of slack — if it needs more than that something is starving.
    let runs = 0;
    let lastCalls = 1;
    while (lastCalls > 0 && runs < 10) {
      const h = linksHarness(c, recs, routes, ['--limit', String(BUDGET)]);
      assert.equal(await h.promise, 0);
      lastCalls = h.calls.length;
      runs++;
    }
    assert.ok(runs <= Math.ceil(9 / BUDGET) + 1, `converged in ${runs} runs, expected ≤ 6`);
    assert.equal(verdictRows(c.dbFile).length, 9, 'every link decided');

    // Held: a further run over the settled cache asks the register for nothing at all.
    const settled = linksHarness(c, recs, routes, ['--limit', String(BUDGET)]);
    assert.equal(await settled.promise, 0);
    assert.deepEqual(settled.calls, [], 'coverage stays at 1.0 without further requests');
  } finally {
    c.cleanup();
  }
});

test('the refresh window comes round faster than retention empties it', () => {
  // The three constants are ONE convergence condition, and the version this replaced set them so that
  // it could never be met: everything expired between monthly runs, so each run re-faced the whole set
  // and covered barely half of it, for ever. Asserted here because it is a property of the numbers,
  // not of any one function.
  const CADENCE_DAYS = 7; // related-persons-data.yml cron
  const MAX_AGE_DAYS = 30; // the workflow's tr_max_age_days default
  assert.ok(
    VERDICT_RETENTION_DAYS > MAX_AGE_DAYS + CADENCE_DAYS,
    `a verdict must not be purged before its turn comes round: retention ${VERDICT_RETENTION_DAYS} ` +
      `must exceed max-age ${MAX_AGE_DAYS} + one cadence gap ${CADENCE_DAYS}`,
  );
  assert.ok(
    MAX_AGE_DAYS > CADENCE_DAYS,
    'and a link must not come due every single run, or every run re-faces the whole set',
  );
});

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
