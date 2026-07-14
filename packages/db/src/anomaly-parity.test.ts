/// <reference types="node" />
// Guard against silent drift of the anomaly derive/scoring SQL, which is intentionally duplicated
// between scripts/precompute.sql §7 (full rebuild) and scripts/refresh-slice.sql (@refresh-batch
// anomalies, scoped daily re-derive). The two copies must stay byte-identical between the
// @anomaly-derive markers — only the FROM/WHERE scoping between the marked regions may differ
// (full corpus vs touched slice). A threshold or weight changed in one file but not the other
// fails HERE instead of silently disagreeing in production.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const precomputeSql = readFileSync(resolve(root, 'scripts/precompute.sql'), 'utf8').replaceAll('\r\n', '\n');
const refreshSliceSql = readFileSync(resolve(root, 'scripts/refresh-slice.sql'), 'utf8').replaceAll('\r\n', '\n');

/** The text strictly between a `-- @<name> begin…` line and its `-- @<name> end…` line. */
function markedRegion(sql: string, name: string, file: string): string {
  const begin = new RegExp(`^-- @${name} begin[^\\n]*\\n`, 'm').exec(sql);
  const end = new RegExp(`^-- @${name} end[^\\n]*$`, 'm').exec(sql);
  if (!begin || !end) throw new Error(`missing @${name} begin/end markers in ${file}`);
  return sql.slice(begin.index + begin[0].length, end.index);
}

describe('anomaly derive parity (precompute.sql §7 ↔ refresh-slice.sql)', () => {
  it('keeps the shared derive/scoring block byte-identical', () => {
    const a = markedRegion(precomputeSql, 'anomaly-derive', 'scripts/precompute.sql');
    const b = markedRegion(refreshSliceSql, 'anomaly-derive', 'scripts/refresh-slice.sql');
    expect(a).toBe(b);
    // The block really is the one carrying every threshold/weight, not an empty region.
    for (const invariant of [
      'INSERT INTO contract_anomalies (',
      '>= 1.10 THEN 1 ELSE 0 END AS flag_over',
      '>= 1.20 THEN 1 ELSE 0 END AS flag_annex',
      'x.ratio >= 5 AND x.amount_eur >= 50000',
      'ps.peers >= 10',
      "'Пряко договаряне'",
    ]) {
      expect(a).toContain(invariant);
    }
  });

  it('keeps the shared qualifying-rows tail byte-identical', () => {
    const a = markedRegion(precomputeSql, 'anomaly-derive-tail', 'scripts/precompute.sql');
    const b = markedRegion(refreshSliceSql, 'anomaly-derive-tail', 'scripts/refresh-slice.sql');
    expect(a).toBe(b);
    expect(a).toContain('WHERE flag_over = 1 OR flag_annex = 1 OR flag_outlier = 1;');
  });

  it('keeps score and rank_value on the same weights within the shared block', () => {
    // rank_value = score×1e12 + amount is a second copy of the score expression inside each file;
    // pin the two copies to each other so a weight edited in one spot cannot skew the sort silently.
    const region = markedRegion(precomputeSql, 'anomaly-derive', 'scripts/precompute.sql');
    const score = /(MIN\(100,[\s\S]*?\)) AS score,/.exec(region)?.[1];
    const rank = /AS score,\s*(MIN\(100,[\s\S]*?\)) \* 1e12 \+ amount_eur AS rank_value,/.exec(
      region,
    )?.[1];
    expect(score).toBeTruthy();
    expect(rank).toBe(score);
  });

  it('keeps the clean-corpus scope predicate in both scoping sections', () => {
    // The scoping sections between the markers legitimately differ (full corpus vs touched slice),
    // but both must select only clean rows.
    const scope = "WHERE c.value_flag = 'ok' AND c.amount_eur > 0";
    expect(precomputeSql).toContain(scope);
    expect(refreshSliceSql).toContain(scope);
  });
});
