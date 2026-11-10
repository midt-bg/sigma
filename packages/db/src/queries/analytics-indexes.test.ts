/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, URL } from 'node:url';
import { d1FromSqlite } from '@sigma/test-support';
import { describe, expect, it } from 'vitest';
import { getCompetition } from './competition';
import { getSpendingTrend } from './trend';

const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(migrations)
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(`${migrations}/${file}`, 'utf8'));
  sqlite.exec(`
    INSERT INTO authorities(id, name, type_group) VALUES ('auth:test', 'Община Тест', 'община');
    INSERT INTO bidders(id, name, kind) VALUES
      ('bidder:a', 'ТЕСТ А ЕООД', 'company'), ('bidder:b', 'ТЕСТ Б ЕООД', 'company');
    INSERT INTO tenders(id, source_id, title, authority_id, cpv_code, procedure_type) VALUES
      ('t:a', 'test-a', 'Поръчка А', 'auth:test', '45000000', 'Открита процедура'),
      ('t:b', 'test-b', 'Поръчка Б', 'auth:test', '72000000', 'Пряко договаряне');
    INSERT INTO contracts(id, tender_id, bidder_id, amount, amount_eur, signed_at, bids_received, eu_funded) VALUES
      ('c:1', 't:a', 'bidder:a', 1, 100, '2024-01-01', 1, 1),
      ('c:2', 't:a', 'bidder:b', 1, 200, '2024-02-01', 3, 1),
      ('c:3', 't:b', 'bidder:a', 1, -20, '2025-03-01', 1, NULL),
      ('c:4', 't:b', 'bidder:b', 1, 0, NULL, 0, 0),
      ('c:5', 't:b', 'bidder:a', 1, NULL, '2025-01-01', NULL, 0),
      ('c:6', 't:b', 'bidder:b', 1, 10, '2999-01-01', NULL, 0),
      ('c:7', 't:b', 'bidder:a', 1, 5, 'bad-date', NULL, 0);
    INSERT INTO flow_pairs VALUES
      ('auth:test', 'bidder:a', 'Община Тест', 'ТЕСТ А ЕООД', 'company', 85, 3),
      ('auth:test', 'bidder:b', 'Община Тест', 'ТЕСТ Б ЕООД', 'company', 210, 3);
  `);
  return sqlite;
}

describe('analytical covering access paths', () => {
  it('keeps every result while avoiding large table reads for national and filtered panels', async () => {
    const sqlite = fixture();
    try {
      const current = d1FromSqlite(sqlite);
      const baseline = d1FromSqlite(sqlite);
      const legacyPrepare = baseline.prepare;
      // The previous SQL differs only in its access paths. Compare all returned fields on identical
      // inputs, including positive-only HHI versus net trend value, missing values and date coverage.
      baseline.prepare = (sql) => legacyPrepare(sql.replace(/ INDEXED BY \w+/g, ''));
      const statements: string[] = [];
      const prepare = current.prepare;
      current.prepare = (sql) => {
        statements.push(sql);
        return prepare(sql);
      };
      for (const params of [
        { minContracts: 1 },
        { minContracts: 1, sector: '45', year: '2024', funding: 'eu' as const },
        { minContracts: 1, authorityId: 'auth:test', funding: 'national' as const },
      ]) {
        expect(await getCompetition(current, params)).toEqual(
          await getCompetition(baseline, params),
        );
      }
      for (const params of [
        { granularity: 'year' as const },
        { sector: '45', funding: 'eu' as const },
        { authorityId: 'auth:test' },
        { bidderId: 'bidder:a', funding: 'national' as const },
      ]) {
        expect(await getSpendingTrend(current, params)).toEqual(
          await getSpendingTrend(baseline, params),
        );
      }
      const trend = await getSpendingTrend(current, { granularity: 'year' });
      expect(trend.totalValueEur).toBe(280);
      expect(trend.coverage).toMatchObject({ total: 6, dated: 4, omitted: 3, omittedEur: 15 });
      const eu = await getCompetition(current, { minContracts: 1, funding: 'eu' });
      expect(eu.byConcentration[0]).toMatchObject({ contracts: 2, suppliers: 2, valueEur: 300 });
      expect(eu.byConcentration[0]!.hhi).toBeCloseTo(5 / 9);

      const plans = statements.map((sql) => ({
        sql,
        details: sqlite
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...Array((sql.match(/\?/g) ?? []).length).fill(null))
          .map((r) => String(r.detail)),
      }));
      for (const { details } of plans.filter((p) =>
        p.sql.includes('INDEXED BY idx_contracts_analytics_cover'),
      )) {
        expect(
          details.some((d) => d.includes('COVERING INDEX idx_contracts_analytics_cover')),
        ).toBe(true);
      }
      for (const { details } of plans.filter((p) =>
        p.sql.includes('INDEXED BY idx_contracts_trend_cover'),
      )) {
        expect(details.some((d) => d.includes('COVERING INDEX idx_contracts_trend_cover'))).toBe(
          true,
        );
      }
      const recurrence = plans.find((p) => p.sql.includes('FROM flow_pairs'))!;
      expect(recurrence.details.some((d) => d.includes('idx_flow_pairs_recurrence'))).toBe(true);
      expect(recurrence.details.some((d) => d.includes('TEMP B-TREE FOR ORDER BY'))).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});
