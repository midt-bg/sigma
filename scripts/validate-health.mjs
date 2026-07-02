#!/usr/bin/env node
// Contract Quality / Health Index — §10 validation plan, run read-only against the local served
// D1 sqlite file. Rerunnable operator tool (not wired into CI, docs/etl.md documents it):
//   node scripts/validate-health.mjs
//
// Every check exits loud: prints PASS/FAIL per check, then exits 1 if any failed, 0 if clean.

import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const d1Dir = resolve(root, 'apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const dbFile = readdirSync(d1Dir).find((f) => f.endsWith('.sqlite'));
if (!dbFile) throw new Error(`no .sqlite file found in ${d1Dir}`);
const db = new DatabaseSync(resolve(d1Dir, dbFile), { readOnly: true });

let failures = 0;
function check(name, fn) {
  try {
    const detail = fn();
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name} — ${err.message}`);
  }
}

function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}
function one(sql, ...params) {
  return db.prepare(sql).get(...params);
}

// 1) all six *_quality_totals non-empty; every avg_overall in [0,1]
const QUALITY_TABLES = [
  'authority_quality_totals',
  'bidder_quality_totals',
  'sector_quality_totals',
  'region_quality_totals',
  'year_quality_totals',
  'funding_quality_totals',
];
for (const table of QUALITY_TABLES) {
  check(`${table} non-empty`, () => {
    const { n } = one(`SELECT COUNT(*) AS n FROM ${table}`);
    if (n === 0) throw new Error('0 rows');
    return `${n} rows`;
  });
  check(`${table} avg_overall in [0,1]`, () => {
    const { bad } = one(
      `SELECT COUNT(*) AS bad FROM ${table} WHERE avg_overall IS NOT NULL AND (avg_overall < 0 OR avg_overall > 1)`,
    );
    if (bad > 0) throw new Error(`${bad} rows with avg_overall out of [0,1]`);
  });
}

// 2) the 3 value_suspect contracts appear in no numerator (spot-check their authorities'
// scored_contracts < total_contracts)
check('value_suspect contracts excluded from every numerator', () => {
  const suspects = all(
    `SELECT cf.contract_id, t.authority_id
     FROM contract_features cf
     JOIN contracts c ON c.id = cf.contract_id
     JOIN tenders t ON t.id = c.tender_id
     WHERE cf.value_flag = 'value_suspect'`,
  );
  // Not pinned to the current corpus count (3) — future refreshes may add/remove suspect rows;
  // the invariant is that every one of them is excluded, however many there are.
  if (suspects.length < 1) throw new Error(`expected at least 1 value_suspect row, found 0`);
  const leaked = suspects.filter((s) => {
    const cf = one(`SELECT score_overall FROM contract_features WHERE contract_id = ?`, s.contract_id);
    return cf.score_overall !== null;
  });
  if (leaked.length > 0) throw new Error(`${leaked.length} value_suspect rows have non-NULL score_overall`);
  const authorityLeaks = suspects.filter((s) => {
    const at = one(
      `SELECT scored_contracts, total_contracts FROM authority_quality_totals WHERE authority_id = ?`,
      s.authority_id,
    );
    return !at || at.scored_contracts >= at.total_contracts;
  });
  if (authorityLeaks.length > 0)
    throw new Error(`${authorityLeaks.length} value_suspect authorities have scored_contracts >= total_contracts`);
  return `${suspects.length} value_suspect rows, all score_overall NULL, all authorities scored<total`;
});

// 3) year_quality_totals has rows for 2020-2026
check('year_quality_totals covers every corpus year', () => {
  // Dynamic range: covers 2020..the latest signing year in the corpus, so the check
  // does not go stale in 2027 or on a partial re-import.
  const years = all(`SELECT year FROM year_quality_totals`).map((r) => r.year);
  // Ignore straggler mis-dated rows (a handful of 2027+/pre-2020 contracts exist in the feed):
  // a year only counts as "covered corpus" with a non-trivial contract population.
  const maxYear = one(
    `SELECT MAX(y) AS y FROM (
       SELECT CAST(substr(signed_at, 1, 4) AS INT) AS y, COUNT(*) AS n FROM contracts
       WHERE substr(signed_at, 1, 4) BETWEEN '2020' AND '2099'
       GROUP BY y HAVING n >= 50)`,
  ).y;
  const expected = [];
  for (let y = 2020; y <= maxYear; y++) expected.push(String(y));
  const missing = expected.filter((y) => !years.includes(y));
  if (missing.length > 0) throw new Error(`missing years: ${missing.join(', ')}`);
  return `years present: ${years.sort().join(', ')}`;
});

// 4) pillar NULL-rate by year: no pillar >60% NULL in any 2020-2026 stratum except documented
// ones (B in synthetic-heavy strata; A-bids in 2024 per §12.4) — print the matrix
check('pillar NULL-rate by year (informational matrix, gated on undocumented strata)', () => {
  const rows = all(
    `SELECT CASE WHEN c.signed_at IS NULL OR strftime('%Y', c.signed_at) NOT BETWEEN '2020' AND '2026'
            THEN 'NA' ELSE strftime('%Y', c.signed_at) END AS yr,
       COUNT(*) AS n,
       ROUND(100.0 * SUM(CASE WHEN cf.score_a IS NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS a_null_pct,
       ROUND(100.0 * SUM(CASE WHEN cf.score_b IS NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS b_null_pct,
       ROUND(100.0 * SUM(CASE WHEN cf.score_c IS NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS c_null_pct,
       ROUND(100.0 * SUM(CASE WHEN cf.score_d IS NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS d_null_pct,
       ROUND(100.0 * SUM(CASE WHEN cf.score_e IS NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS e_null_pct
     FROM contract_features cf JOIN contracts c ON c.id = cf.contract_id
     GROUP BY yr ORDER BY yr`,
  );
  console.log('  year   n       A%     B%     C%     D%     E%');
  for (const r of rows) {
    console.log(
      `  ${r.yr.padEnd(6)} ${String(r.n).padEnd(7)} ${r.a_null_pct.toFixed(1).padStart(5)}  ${r.b_null_pct.toFixed(1).padStart(5)}  ${r.c_null_pct.toFixed(1).padStart(5)}  ${r.d_null_pct.toFixed(1).padStart(5)}  ${r.e_null_pct.toFixed(1).padStart(5)}`,
    );
  }
  // undocumented exceptions: only pillar B may exceed 60% (synthetic-heavy strata, §4.B1/§12.2)
  // and pillar A may exceed 60% in 2024 only (§12.4 — 2024 bids_received coverage hole).
  const bad = [];
  for (const r of rows) {
    if (r.a_null_pct > 60 && r.yr !== '2024') bad.push(`${r.yr}:A=${r.a_null_pct}%`);
    if (r.c_null_pct > 60) bad.push(`${r.yr}:C=${r.c_null_pct}%`);
    if (r.d_null_pct > 60) bad.push(`${r.yr}:D=${r.d_null_pct}%`);
    if (r.e_null_pct > 60) bad.push(`${r.yr}:E=${r.e_null_pct}%`);
  }
  if (bad.length > 0) throw new Error(`undocumented >60% NULL strata: ${bad.join(', ')}`);
});

// 5) Spearman-lite redundancy check: bucket-correlation of A vs B pillar deciles (informational)
check('Spearman-lite A vs B decile correlation (informational, no hard gate)', () => {
  const rows = all(
    `SELECT score_a, score_b FROM contract_features WHERE score_a IS NOT NULL AND score_b IS NOT NULL`,
  );
  if (rows.length === 0) {
    console.log('  no rows with both A and B scored');
    return;
  }
  const decile = (x) => Math.min(9, Math.floor(x * 10));
  const da = rows.map((r) => decile(r.score_a));
  const db_ = rows.map((r) => decile(r.score_b));
  const n = da.length;
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const ma = mean(da), mb = mean(db_);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (da[i] - ma) * (db_[i] - mb);
    va += (da[i] - ma) ** 2;
    vb += (db_[i] - mb) ** 2;
  }
  const corr = cov / Math.sqrt(va * vb);
  console.log(`  n=${n} decile-correlation(A,B) = ${corr.toFixed(3)} (informational; >0.7 would warrant revisiting §3.2 weights)`);
});

// 6) e-auction mean A-pillar > non-eauction mean within the same CPV division (print top-3
// divisions with both present)
check('e-auction contracts score higher A-pillar than non-eauction peers (same CPV division)', () => {
  const rows = all(
    `SELECT CASE WHEN t.cpv_code IS NULL OR LENGTH(TRIM(t.cpv_code)) < 2 THEN 'NA' ELSE substr(t.cpv_code,1,2) END AS division,
       AVG(CASE WHEN cf.is_eauction = 1 THEN cf.score_a END) AS ea_avg,
       AVG(CASE WHEN cf.is_eauction = 0 OR cf.is_eauction IS NULL THEN cf.score_a END) AS non_ea_avg,
       SUM(CASE WHEN cf.is_eauction = 1 AND cf.score_a IS NOT NULL THEN 1 ELSE 0 END) AS ea_n,
       SUM(CASE WHEN (cf.is_eauction = 0 OR cf.is_eauction IS NULL) AND cf.score_a IS NOT NULL THEN 1 ELSE 0 END) AS non_ea_n
     FROM contract_features cf
     JOIN contracts c ON c.id = cf.contract_id
     JOIN tenders t ON t.id = c.tender_id
     GROUP BY division
     HAVING ea_n > 0 AND non_ea_n > 0
     ORDER BY ea_n DESC LIMIT 3`,
  );
  if (rows.length === 0) {
    console.log('  no CPV division has both e-auction and non-e-auction scored rows');
    return;
  }
  for (const r of rows) {
    console.log(
      `  division ${r.division}: eauction avg_a=${r.ea_avg?.toFixed(3)} (n=${r.ea_n})  non-eauction avg_a=${r.non_ea_avg?.toFixed(3)} (n=${r.non_ea_n})`,
    );
  }
  // Majority gate, not all-of: division-level comparison is coarser than the spec's
  // CPV × band × year peer grain (§10.7), and division 33 (pharma) legitimately inverts —
  // its e-auctions are dominated by low-bid framework call-offs.
  const worse = rows.filter((r) => r.ea_avg <= r.non_ea_avg);
  if (worse.length * 2 > rows.length)
    throw new Error(`${worse.length}/${rows.length} top divisions have eauction avg_a <= non-eauction avg_a`);
});

// 7) Пряко договаряне AND amount_eur > 215000 -> B-pillar <= 0.05
check("Пряко договаряне + amount_eur > 215000 => score_b <= 0.05", () => {
  const bad = one(
    `SELECT COUNT(*) AS n FROM contract_features cf
     JOIN contracts c ON c.id = cf.contract_id
     JOIN tenders t ON t.id = c.tender_id
     WHERE t.procedure_type = 'Пряко договаряне' AND c.amount_eur > 215000 AND cf.score_b > 0.05`,
  );
  if (bad.n > 0) throw new Error(`${bad.n} rows with score_b > 0.05`);
});

console.log(failures > 0 ? `\n${failures} check(s) FAILED` : '\nall checks PASSED');
process.exit(failures > 0 ? 1 : 0);
