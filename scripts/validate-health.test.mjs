import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { missingYears } from './validate-health.mjs';

describe('missingYears', () => {
  it('reports no gaps when every expected year is present as TEXT', () => {
    assert.deepEqual(missingYears(['2020', '2021', '2022'], ['2020', '2021', '2022']), []);
  });

  it('matches an INTEGER-column year against string-expected years (previously an always-FAIL)', () => {
    // Simulates a driver/schema that hands back `year` as a JS number rather than a string —
    // a bare `expected.includes(y)` comparison would treat every year as missing here.
    assert.deepEqual(missingYears([2020, 2021, 2022], ['2020', '2021', '2022']), []);
  });

  it('still reports a genuinely missing year regardless of type', () => {
    assert.deepEqual(missingYears([2020, 2022], ['2020', '2021', '2022']), ['2021']);
  });
});
