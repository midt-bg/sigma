import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertSameHost,
  deleteSqlForEopSources,
  isWithinMissingSettleWindow,
} from './load-eop.mjs';

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
