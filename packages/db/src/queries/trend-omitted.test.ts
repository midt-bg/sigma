/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { getSpendingTrend } from './trend';

// A profile's yearly table plus what it leaves out must add up to the profile total.
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../migrations');

describe('getSpendingTrend omitted contracts', () => {
  it('counts the contracts and value the series leaves out, so the table reconciles', async () => {
    const sqlite = new DatabaseSync(':memory:');
    for (const file of readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort())
      sqlite.exec(readFileSync(resolve(migrationsDir, file), 'utf8'));
    sqlite.exec(`
      INSERT INTO authorities (id, name, bulstat, type_group) VALUES ('auth:100000001', 'Община Тест', '100000001', 'община');
      INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
        ('eik:200000001', 'ТЕСТ ГРУП ЕООД', '200000001', '200000001', 1, 'company');
      INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type, status) VALUES
        ('t:1', 'UNP-1', 'Поръчка', 'auth:100000001', '45000000', 'открита процедура', 'awarded');
      INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, value_flag, amount_eur) VALUES
        ('c:2024',   't:1', 'eik:200000001', 100, 'EUR', '2024-05-01', 'ok', 100),
        ('c:2025',   't:1', 'eik:200000001', 200, 'EUR', '2025-05-01', 'ok', 200),
        ('c:nodate', 't:1', 'eik:200000001', 30,  'EUR', NULL,         'ok', 30),
        ('c:old',    't:1', 'eik:200000001', 40,  'EUR', '2016-01-20', 'ok', 40),
        ('c:future', 't:1', 'eik:200000001', 50,  'EUR', '2999-05-14', 'ok', 50),
        ('c:novalue','t:1', 'eik:200000001', 1,   'XYZ', NULL,         'ok', NULL);
    `);
    const trend = await getSpendingTrend(
      d1FromSqlite(sqlite),
      { bidderId: 'eik:200000001', granularity: 'year' },
      { includeSectors: false },
    );
    sqlite.close();
    expect(trend.years.map((y) => [y.year, y.contracts, y.valueEur])).toEqual([
      ['2024', 1, 100],
      ['2025', 1, 200],
    ]);
    // No date, before the series starts, in the future; the contract with no value is in no total at all.
    expect(trend.coverage).toMatchObject({ omitted: 3, omittedEur: 120 });
  });
});
