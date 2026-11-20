/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { contractsSummary, listContracts } from './contracts';
import { getAuthority, getCompany } from './details';

// A profile's „Брой договори" is the summed count from the rollups (authority_totals / company_totals). Its
// contracts list also has the framework agreements (a ceiling, never summed) and the contracts with no value,
// and the profile names both — so summed + agreements + no value must be exactly the list, each row in one
// group only. Built through the real migrations and precompute.sql, read through the real queries.
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../migrations');
const migrations = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(resolve(migrationsDir, file), 'utf8'));
const precompute = readFileSync(resolve(here, '../../../../scripts/precompute.sql'), 'utf8');

const AUTHORITY = '000999990'; // invented
const COMPANY = '209999994'; // invented
const OTHER = '209999995'; // invented — a second contractor of the same authority

let sqlite: DatabaseSync;
let db: D1Database;

beforeAll(() => {
  sqlite = new DatabaseSync(':memory:');
  for (const migration of migrations) sqlite.exec(migration);
  sqlite.exec(`
    INSERT INTO authorities (id, name, bulstat) VALUES ('auth:${AUTHORITY}', 'Община Тест', '${AUTHORITY}');
    INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type, status) VALUES
      ('t-1', '00999-2025-0001', 'Тестова поръчка', 'auth:${AUTHORITY}', '45000000', 'открита процедура', 'closed'),
      ('t-fa', '00999-2025-0002', 'Тестово рамково споразумение', 'auth:${AUTHORITY}', '45000000', 'открита процедура', 'closed');
    INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid) VALUES
      ('eik:${COMPANY}', 'ТЕСТ ГРУП ЕООД', '${COMPANY}', '${COMPANY}', 1),
      ('eik:${OTHER}', 'ДРУГ ТЕСТ ЕООД', '${OTHER}', '${OTHER}', 1);
    INSERT INTO contracts
      (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, amount_eur, signing_value, signing_value_eur, framework)
    VALUES
      -- three ordinary contracts with a value
      ('c:1', 't-1', 'eik:${COMPANY}', 100, 'EUR', '2025-01-10', 'Д-1', 100, 100, 100, NULL),
      ('c:2', 't-1', 'eik:${COMPANY}', 200, 'EUR', '2025-01-11', 'Д-2', 200, 200, 200, NULL),
      ('c:3', 't-1', 'eik:${COMPANY}', 300, 'EUR', '2025-01-12', 'Д-3', 300, 300, 300, NULL),
      -- an order under a framework agreement: an ordinary, summed contract
      ('c:4', 't-fa', 'eik:${COMPANY}', 50, 'EUR', '2025-03-01', 'Д-4', 50, 50, 50, 1),
      -- two without a value, one with an explicit „not a framework" flag
      ('c:5', 't-1', 'eik:${COMPANY}', 0, 'EUR', '2025-02-01', 'Д-5', NULL, NULL, NULL, NULL),
      ('c:6', 't-1', 'eik:${COMPANY}', 0, 'EUR', '2025-02-02', 'Д-6', NULL, NULL, NULL, 0),
      -- two framework agreements: a ceiling, no summed value
      ('c:7', 't-fa', 'eik:${COMPANY}', 5000, 'EUR', '2025-02-10', 'РС-1', NULL, 5000, 5000, 2),
      ('c:8', 't-fa', 'eik:${COMPANY}', 7000, 'EUR', '2025-02-11', 'РС-2', NULL, 7000, 7000, 2),
      -- the other contractor: the authority's rows, not the company's
      ('c:9', 't-1', 'eik:${OTHER}', 400, 'EUR', '2025-01-20', 'Д-9', 400, 400, 400, NULL),
      ('c:10', 't-fa', 'eik:${OTHER}', 9000, 'EUR', '2025-02-12', 'РС-3', NULL, 9000, 9000, 2);
  `);
  sqlite.exec(precompute);
  db = d1FromSqlite(sqlite);
});

afterAll(() => sqlite.close());

async function listIds(filter: { authority?: string; bidder?: string }): Promise<string[]> {
  const page = await listContracts(db, { ...filter, pageSize: 50 });
  return page.items.map((item) => item.id);
}

describe('profile contract count against the contracts list', () => {
  it('splits the authority’s list into summed, framework agreements and no value, once each', async () => {
    const a = (await getAuthority(db, `auth:${AUTHORITY}`))!;
    expect({
      contracts: a.contracts,
      frameworkAgreements: a.frameworkAgreements,
      missingValue: a.missingValue,
    }).toEqual({ contracts: 5, frameworkAgreements: 3, missingValue: 2 });

    const listed = await contractsSummary(db, { authority: AUTHORITY });
    const ids = await listIds({ authority: AUTHORITY });
    expect(a.contracts + a.frameworkAgreements + a.missingValue).toBe(listed.total);
    expect(ids).toHaveLength(listed.total);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('splits the company’s list the same way, without the other contractor’s rows', async () => {
    const c = (await getCompany(db, `eik:${COMPANY}`))!;
    expect({
      contracts: c.contracts,
      frameworkAgreements: c.frameworkAgreements,
      missingValue: c.missingValue,
    }).toEqual({ contracts: 4, frameworkAgreements: 2, missingValue: 2 });

    const listed = await contractsSummary(db, { bidder: COMPANY });
    const ids = await listIds({ bidder: COMPANY });
    expect(c.contracts + c.frameworkAgreements + c.missingValue).toBe(listed.total);
    expect(ids).toHaveLength(listed.total);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('counts the framework agreements apart from the summed value, and the order under one inside it', async () => {
    const c = (await getCompany(db, `eik:${COMPANY}`))!;
    expect(c.wonEur).toBe(650); // 100 + 200 + 300 + the 50 order; no ceiling
    expect(c.frameworkCeilingEur).toBe(12_000);
  });
});
