import { test } from 'node:test';
import assert from 'node:assert/strict';
import { politeGet, parseCrawlOptions, MAX_CONCURRENCY } from './fetch.mjs';

test('source concurrency shares the socket ceiling and retries honour Retry-After', async () => {
  assert.equal(parseCrawlOptions([]).concurrency, MAX_CONCURRENCY);
  const delays = [];
  const responses = [
    { status: 429, headers: { 'retry-after': '4' } },
    { status: 503, headers: { 'retry-after': 'Mon, 14 Sep 2026 00:00:07 GMT' } },
    { status: 200 },
  ];
  const result = await politeGet('https://source.test', {
    get: async () => responses.shift(),
    pause: async (ms) => {
      delays.push(ms);
    },
    now: () => Date.parse('2026-09-14T00:00:00Z'),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(delays, [4000, 7000]);
});
