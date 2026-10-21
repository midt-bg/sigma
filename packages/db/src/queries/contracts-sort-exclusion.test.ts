/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { listContracts } from './contracts';

// „стойност ↑“ and „нови“ on a real schema: the rows that would lead those sorts with noise (unverified
// near-0 € values, a signing date in the future) are left out of that sort only.
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../migrations');
const migrations = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(resolve(migrationsDir, file), 'utf8'));

const FIXTURE = `
INSERT INTO authorities (id, name, bulstat, type_group) VALUES ('auth:100000001', 'Община Тест', '100000001', 'община');
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
  ('eik:200000001', 'ТЕСТ ГРУП ЕООД', '200000001', '200000001', 1, 'company');
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type, status) VALUES
  ('t:1', 'UNP-1', 'Поръчка', 'auth:100000001', '45000000', 'открита процедура', 'awarded');
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, value_flag, amount_eur) VALUES
  ('c:zero',   't:1', 'eik:200000001', 0,    'EUR', '2025-03-01', 'value_low', 0),
  ('c:tiny',   't:1', 'eik:200000001', 0.01, 'EUR', '2025-03-02', 'value_low', 0.0051),
  ('c:small',  't:1', 'eik:200000001', 50,   'EUR', '2025-03-03', 'ok',        50),
  ('c:large',  't:1', 'eik:200000001', 9000, 'EUR', '2026-01-01', 'ok',        9000),
  ('c:future', 't:1', 'eik:200000001', 700,  'EUR', '2999-05-14', 'ok',        700),
  ('c:none',   't:1', 'eik:200000001', 1,    'XYZ', NULL,         'ok',        NULL);
`;

let open: DatabaseSync | null = null;
function realDb(): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of migrations) sqlite.exec(migration);
  sqlite.exec(FIXTURE);
  open = sqlite;
  return d1FromSqlite(sqlite);
}
afterEach(() => {
  open?.close();
  open = null;
});

const ids = async (sort: string) =>
  (await listContracts(realDb(), { sort: sort as never, pageSize: 10 })).items.map((i) => i.id);

describe('list sorts that leave out noise', () => {
  it('„стойност ↑“ opens with the smallest verified value, not the unverified 0 € rows', async () => {
    expect(await ids('value-asc')).toEqual(['small', 'future', 'large', 'none']);
  });

  it('„нови“ opens with the newest real date, not one in the future', async () => {
    expect(await ids('date-desc')).toEqual(['large', 'small', 'tiny', 'zero', 'none']);
  });

  it('the other sorts and the headline still carry every contract', async () => {
    const page = await listContracts(realDb(), { sort: 'value-desc', pageSize: 10 });
    expect(page.items.map((i) => i.id)).toEqual([
      'large',
      'future',
      'small',
      'tiny',
      'zero',
      'none',
    ]);
    expect(page.total).toBe(6);
    expect(await ids('date-asc')).toEqual(['zero', 'tiny', 'small', 'large', 'future', 'none']);
  });
});
