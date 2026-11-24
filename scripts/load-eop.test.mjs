import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { baseSqlLiteral, mapBaseRecord } from '../packages/ingest/src/base.ts';

import {
  assertSameHost,
  deleteSqlForEopSources,
  isWithinMissingSettleWindow,
} from './load-eop.mjs';

it('round-trips supplier evidence through generated SQL and bound TEXT', () => {
  const db = new DatabaseSync(':memory:');
  const meta = { day: '2026-06-01', fetchedAt: '2026-06-01' };
  const valid = '0000000000015';
  const quoted = "Тест O'Brien; SELECT 'fixture'; --";
  try {
    db.exec('CREATE TABLE suppliers (id TEXT)');
    for (const category of ['contracts', 'annexes']) {
      for (const [input, expected] of [
        [undefined, null],
        ['   ', null],
        [`  ЕИК ${valid}  `, `ЕИК ${valid}`],
        ['\t', '\t'],
        [`\n${valid}`, `\n${valid}`],
        ['\u0085', '\u0085'],
        [`000000\0${valid.slice(6)}`, `000000\0${valid.slice(6)}`],
        [quoted, quoted],
        [`${quoted}\0🙂`, `${quoted}\0🙂`],
      ]) {
        const { contractor_eik: mapped } = mapBaseRecord(
          category,
          { contractNumber: 'FIXTURE', supplierRegisterNumber: input },
          meta,
        );
        assert.equal(mapped, expected);
        db.exec('DELETE FROM suppliers');
        db.prepare('INSERT INTO suppliers VALUES (?)').run(mapped);
        db.exec(
          `INSERT INTO suppliers VALUES (${baseSqlLiteral(category, 'contractor_eik', mapped)});`,
        );
        const rows = db.prepare('SELECT typeof(id) AS type, hex(id) AS bytes FROM suppliers').all();
        assert.equal(rows.length, 2);
        assert.deepEqual(rows[1], rows[0]);
      }
    }
  } finally {
    db.close();
  }
});

describe('assertSameHost', () => {
  it('accepts same-host final URLs and responses without a final URL', () => {
    assert.doesNotThrow(() =>
      assertSameHost('https://storage.eop.bg/open-data-2024-01-02/', {
        url: 'https://storage.eop.bg/open-data-2024-01-02/?list-type=2',
      }),
    );
    assert.doesNotThrow(() =>
      assertSameHost('https://storage.eop.bg/open-data-2024-01-02/', { url: '' }),
    );
  });

  it('rejects cross-host final URLs', () => {
    assert.throws(
      () =>
        assertSameHost('https://storage.eop.bg/open-data-2024-01-02/', {
          url: 'https://example.com/open-data-2024-01-02/',
        }),
      /Refusing cross-host redirect/,
    );
  });
});

describe('deleteSqlForEopSources', () => {
  it('keeps the existing single-day source wipe', () => {
    assert.equal(
      deleteSqlForEopSources('raw_contracts', 'contracts', ['2024-01-02']),
      "DELETE FROM raw_contracts WHERE source = 'eop:contracts:2024-01-02';\n",
    );
  });

  it('scopes multi-day wipes to the requested window', () => {
    const sql = deleteSqlForEopSources('raw_contracts', 'contracts', ['2024-01-02', '2024-01-03']);

    assert.equal(
      sql,
      "DELETE FROM raw_contracts WHERE source IN (\n  'eop:contracts:2024-01-02',\n  'eop:contracts:2024-01-03'\n);\n",
    );
    assert.equal(sql.includes("source LIKE 'eop:contracts:%'"), false);
  });
});

describe('isWithinMissingSettleWindow', () => {
  it('treats the trailing default window as unsettled', () => {
    assert.equal(isWithinMissingSettleWindow('2026-06-07', '2026-06-10', 3), true);
    assert.equal(isWithinMissingSettleWindow('2026-06-06', '2026-06-10', 3), false);
  });

  it('treats future requested buckets as unsettled', () => {
    assert.equal(isWithinMissingSettleWindow('2026-06-11', '2026-06-10', 3), true);
  });
});
