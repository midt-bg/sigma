import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { d1FromSqlite } from '../../packages/test-support/src/d1-sqlite.ts';
import { importRegistry } from './rebuild-registry.mjs';

test('reads every winner once, retries a failing read, and accepts the baseline', async () => {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync('packages/db/migrations').sort())
    if (f.endsWith('.sql')) db.exec(readFileSync(`packages/db/migrations/${f}`, 'utf8'));
  db.exec(`
    INSERT INTO authorities (id, name) VALUES ('a:1','ОБЩИНА');
    INSERT INTO tenders (id, source_id, title, authority_id, procedure_type) VALUES ('t:1','u','Т','a:1','открита');
    INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
      ('eik:111111111','ЕДНО','111111111','111111111',1,'company'),
      ('eik:222222222','ДВЕ','222222222','222222222',1,'company');
    INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, amount_eur) VALUES
      ('c:1','t:1','eik:111111111',1,'EUR','2024-01-01','1',1),('c:2','t:1','eik:222222222',1,'EUR','2024-01-01','2',1);`);
  const calls = [];
  let flaky = 1;
  const client = {
    deed: async (eik) => {
      calls.push(eik);
      if (eik === '222222222' && flaky-- > 0) throw new Error('timeout');
      return { status: 'absent' };
    },
  };
  const read = await importRegistry(d1FromSqlite(db), client, { runId: 'r', wait: async () => {} });
  assert.equal(read, 2);
  assert.deepEqual(calls, ['111111111', '222222222', '222222222']);
  assert.equal(db.prepare('SELECT baseline_status s FROM registry_entry_state').get().s, 'ready');
  await assert.rejects(
    importRegistry(d1FromSqlite(db), client, { runId: 'again', wait: async () => {} }),
    /not empty/,
  );
  db.close();
});
