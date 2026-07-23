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
import { PROCEDURE_GROUPS } from '@sigma/config';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const precomputeSql = readFileSync(resolve(root, 'scripts/precompute.sql'), 'utf8').replaceAll('\r\n', '\n');
const refreshSliceSql = readFileSync(resolve(root, 'scripts/refresh-slice.sql'), 'utf8').replaceAll('\r\n', '\n');

/** The text strictly between a `-- @<name> begin…` line and its `-- @<name> end…` line.
 *  Extraction is EXCLUSIVE: the marker lines themselves are not part of the returned string.
 *  The begin regex consumes the entire begin line + newline; the end regex anchors to the start
 *  of the end line so `end.index` points before the end marker. */
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
    expect(a).toContain('WHERE flag_over = 1 OR flag_annex = 1 OR flag_outlier = 1');
  });

  it('computes score once and derives rank_value from it (no duplicated scoring expression)', () => {
    const region = markedRegion(precomputeSql, 'anomaly-derive', 'scripts/precompute.sql');
    // score is computed once via MIN(100, …)
    expect(region).toContain(') AS score,');
    // rank_value is derived from score, not by repeating the scoring expression
    expect(region).toContain('score * 1e12 + amount_eur AS rank_value,');
    // exactly ONE occurrence of MIN(100, — a second copy would reintroduce the duplication
    expect((region.match(/MIN\(100,/g) ?? []).length).toBe(1);
  });

  it('marker extraction is exclusive — marker lines are never part of the extracted region', () => {
    // The begin/end lines intentionally differ between files (they name the other file).
    // If extraction were inclusive, the parity comparison would fail even with identical logic.
    const region = markedRegion(precomputeSql, 'anomaly-derive', 'scripts/precompute.sql');
    expect(region).not.toContain('@anomaly-derive');
    // Specifically, the file-name references on the marker lines must not leak in.
    expect(region).not.toContain('refresh-slice.sql');
    expect(region).not.toContain('precompute.sql');
  });

  it('covers all competitive procedure_type values from PROCEDURE_GROUPS in the single_bid clause', () => {
    // PROCEDURE_GROUPS is the canonical source of truth for procedure_type strings.
    // Any value with competitive===true must appear in the single_bid IN list so a
    // one-bid competitive procedure is caught regardless of wording variant.
    const region = markedRegion(precomputeSql, 'anomaly-derive', 'scripts/precompute.sql');
    const competitiveTypes = PROCEDURE_GROUPS.filter((g) => g.competitive === true).flatMap(
      (g) => g.types,
    );
    for (const type of competitiveTypes) {
      expect(region).toContain(`'${type}'`);
    }
  });

  it('covers all direct/no-notice procedure_type values from PROCEDURE_GROUPS in the no_notice clause', () => {
    const region = markedRegion(precomputeSql, 'anomaly-derive', 'scripts/precompute.sql');
    const directTypes = PROCEDURE_GROUPS.filter((g) => g.competitive === false).flatMap(
      (g) => g.types,
    );
    for (const type of directTypes) {
      expect(region).toContain(`'${type}'`);
    }
  });

  it('refresh_touched_contracts is created in the setup batch, before the anomalies batch depends on it', () => {
    // The @refresh-batch setup batch must unconditionally create refresh_touched_contracts before
    // @refresh-batch anomalies — DELETE … WHERE contract_id IN (SELECT id FROM refresh_touched_contracts)
    // and the scoped derive filter both require the table to exist.
    const setupStart = refreshSliceSql.indexOf('-- @refresh-batch setup');
    const anomaliesStart = refreshSliceSql.indexOf('-- @refresh-batch anomalies');
    const createTable = refreshSliceSql.indexOf('CREATE TABLE refresh_touched_contracts');
    expect(setupStart).toBeGreaterThanOrEqual(0);
    expect(anomaliesStart).toBeGreaterThanOrEqual(0);
    // refresh_touched_contracts must be defined before the anomalies batch needs it
    expect(createTable).toBeGreaterThan(setupStart);
    expect(createTable).toBeLessThan(anomaliesStart);
    // The DELETE in the anomalies batch that depends on it must exist
    expect(refreshSliceSql).toContain(
      'DELETE FROM contract_anomalies WHERE contract_id IN (SELECT id FROM refresh_touched_contracts)',
    );
  });

  it('keeps the clean-corpus scope predicate in both scoping sections', () => {
    // The scoping sections between the markers legitimately differ (full corpus vs touched slice),
    // but both must select only clean rows.
    const scope = "WHERE c.value_flag = 'ok' AND c.amount_eur > 0";
    expect(precomputeSql).toContain(scope);
    expect(refreshSliceSql).toContain(scope);
  });
});

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

  it('keeps the clean-corpus scope predicate in both scoping sections', () => {
    // The scoping sections between the markers legitimately differ (full corpus vs touched slice),
    // but both must select only clean rows.
    const scope = "WHERE c.value_flag = 'ok' AND c.amount_eur > 0";
    expect(precomputeSql).toContain(scope);
    expect(refreshSliceSql).toContain(scope);
  });
});
