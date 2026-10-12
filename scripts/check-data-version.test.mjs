import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataVersionWarnings } from './check-data-version.mjs';

const versioned = (version) => ({
  version,
  computedBy: ['scripts/precompute.sql', 'scripts/refresh-slice.sql'],
});

test('a change to a computing file without a new data version is warned about', () => {
  const warnings = dataVersionWarnings({
    changed: ['scripts/precompute.sql', 'docs/etl.md'],
    before: versioned(2),
    after: versioned(2),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /scripts\/precompute\.sql compute stored values.*still says version 2/);
});

test('no warning when the version is raised, nothing computing changed, or the file is new', () => {
  assert.deepEqual(
    dataVersionWarnings({
      changed: ['scripts/precompute.sql'],
      before: versioned(2),
      after: versioned(3),
    }),
    [],
  );
  assert.deepEqual(
    dataVersionWarnings({
      changed: ['apps/web/app/root.tsx'],
      before: versioned(2),
      after: versioned(2),
    }),
    [],
  );
  assert.deepEqual(
    dataVersionWarnings({ changed: ['scripts/precompute.sql'], before: null, after: versioned(2) }),
    [],
  );
});
