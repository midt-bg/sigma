// node:test — the ЕИК checksum, and its PARITY with the SQL that already owns this rule.
//
// Why parity matters: `eik_valid` in scripts/normalize-raw.sql decides which bidders get an ЕИК-keyed
// identity at all, so it defines the ЕИК space the whole matcher works in. A JS twin that disagrees
// would silently accept a code the pipeline rejects (or vice versa) and the registry lookup would be
// made against an entity the rest of the system does not believe exists. The parity test below runs
// both implementations over the same values through node:sqlite, so they cannot drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eikChecksumValid, normalizeEik } from './eik.mjs';

// Real ЕИК, verifiable against the public registers — the only external anchor this rule has.
const REAL = [
  '000696327', // Община София
  '831661388', // Министерство на регионалното развитие
  '115536179', // „ПИМК" ООД
  '207695026', // „Профит Екстра" ЕООД
];

test('accepts real 9-digit ЕИК', () => {
  for (const e of REAL) assert.equal(eikChecksumValid(e), true, e);
});

test('rejects a wrong-digit twin of every real ЕИК', () => {
  // The failure this rule exists to stop (#195): a typo twin passing as a distinct real company and
  // collapsing unrelated suppliers onto one node. Mutating the LAST digit must always break it.
  for (const e of REAL) {
    const bad = e.slice(0, 8) + ((Number(e[8]) + 1) % 10);
    assert.equal(eikChecksumValid(bad), false, `${bad} (twin of ${e})`);
  }
});

test('rejects service codes, wrong lengths and non-digits', () => {
  for (const bad of [
    '000000000',
    '0000000000000',
    '',
    null,
    undefined,
    '12345678', // 8
    '1234567890', // 10 — never a valid ЕИК length, which is what makes the ЕГН guard sound
    '11553617x',
    '115 536 179',
  ]) {
    assert.equal(eikChecksumValid(bad), false, String(bad));
  }
});

test('13-digit branch requires BOTH the 9-digit prefix and the 13th control digit', () => {
  // A клон/поделение code: the leading 9 must themselves be a valid ЕИК, then weights 2,7,3,5.
  const base = '115536179';
  const valid13 = thirteen(base, '001');
  assert.equal(valid13.length, 13, valid13);
  assert.equal(eikChecksumValid(valid13), true, valid13);
  // break the 13th digit
  const broken = valid13.slice(0, 12) + ((Number(valid13[12]) + 1) % 10);
  assert.equal(eikChecksumValid(broken), false, broken);
  // a valid 13th control over an INVALID 9-prefix must still fail — both halves are load-bearing
  assert.equal(eikChecksumValid(thirteen('115536170', '001')), false);
});

// Build a 13-digit ЕИК with a correct final control digit: 9-digit prefix + 3 free digits + control.
// The 2,7,3,5 weights run over positions 9..12 — that is the prefix's OWN control digit plus the three
// free ones — and position 13 is the result.
function thirteen(prefix9, three) {
  const s = prefix9 + three;
  const d = [...s].map(Number);
  const w = (ws) => ws.reduce((a, x, i) => a + x * d[8 + i], 0) % 11;
  let c = w([2, 7, 3, 5]);
  if (c === 10) {
    c = w([4, 9, 5, 7]);
    if (c === 10) c = 0;
  }
  return s + c;
}

test('normalizeEik strips the „ЕИК " prefix and surrounding whitespace, like the SQL does', () => {
  assert.equal(normalizeEik('ЕИК 115536179'), '115536179');
  assert.equal(normalizeEik('  115536179 '), '115536179');
  assert.equal(normalizeEik('115536179'), '115536179');
  assert.equal(normalizeEik('не е ЕИК'), null);
  assert.equal(normalizeEik(null), null);
});

test('normalizeEik preserves leading zeros (public bodies are exactly 000…)', () => {
  // Lose these and the crawler fetches a DIFFERENT company's deed. String in, string out — never a
  // numeric round-trip.
  assert.equal(normalizeEik('000696327'), '000696327');
  assert.equal(typeof normalizeEik('000696327'), 'string');
});

// ── the anti-drift pin ────────────────────────────────────────────────────────
test('JS twin agrees with normalize-raw.sql eik_valid on every value', () => {
  const sql = readFileSync(fileURLToPath(new URL('../normalize-raw.sql', import.meta.url)), 'utf8');
  const expr = extractEikValidExpression(sql);

  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE probe (eik_clean TEXT)');
  const ins = db.prepare('INSERT INTO probe VALUES (?)');

  const cases = [...REAL, ...REAL.map((e) => e.slice(0, 8) + ((Number(e[8]) + 1) % 10))];
  for (const e of REAL) cases.push(thirteen(e, '001'), thirteen(e, '002'));
  // Every 9-digit code over a fixed prefix — exercises BOTH weight passes incl. the second-10 → 0 fallback.
  for (let i = 0; i < 100; i++) cases.push('2011223' + String(i).padStart(2, '0'));
  for (const bad of ['000000000', '0000000000000', '12345678', '1234567890', '11553617x'])
    cases.push(bad);

  for (const c of cases) ins.run(c);
  const rows = db.prepare(`SELECT eik_clean AS e, ${expr} AS v FROM probe`).all();
  db.close();

  assert.ok(rows.length >= 120, `expected a broad probe set, got ${rows.length}`);
  for (const { e, v } of rows) {
    assert.equal(
      eikChecksumValid(e),
      v === 1,
      `disagreement on ${JSON.stringify(e)} (SQL said ${v})`,
    );
  }
});

/**
 * Lift the `CASE … END AS eik_valid` expression straight out of normalize-raw.sql, so the test
 * compares against the FILE and not a copy of it. A copy would drift with the thing it is pinning.
 */
function extractEikValidExpression(sql) {
  const start = sql.indexOf('    CASE\n      WHEN eik_clean IS NULL');
  assert.ok(start > 0, 'eik_valid CASE not found in normalize-raw.sql — the pin lost its anchor');
  const end = sql.indexOf('AS eik_valid', start);
  assert.ok(end > start, 'eik_valid terminator not found');
  return sql.slice(start, end);
}
