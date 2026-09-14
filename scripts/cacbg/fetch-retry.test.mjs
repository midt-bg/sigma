import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  politeGet,
  parseCrawlOptions,
  MAX_CONCURRENCY,
  declarationFolders,
  findDeclaration,
} from './fetch.mjs';

test('misplaced declarations resolve within the year and preserve failed and successful paths', async () => {
  const folders = declarationFolders('2018', ['2018f2', '2019y', '2018y']);
  assert.deepEqual(folders, ['2018', '2018y', '2018f1', '2018h', '2018f2']);
  for (const primaryStatus of [403, 404]) {
    const events = [];
    const found = await findDeclaration(
      '2018',
      'a.xml',
      folders,
      async (folder) => ({
        status: folder === '2018' ? primaryStatus : 200,
        body: Buffer.from('<xml/>'),
      }),
      async (folder, details) => events.push({ folder, ...details }),
    );
    assert.equal(found.sourceFolder, '2018y');
    assert.deepEqual(
      events.map((e) => [e.folder, e.status]),
      [
        ['2018', primaryStatus],
        ['2018y', 200],
      ],
    );
  }
  const calls = [];
  const found = await findDeclaration(
    '2018',
    'a.xml',
    folders,
    async (folder) => {
      calls.push(folder);
      return { status: folder === '2018h' ? 200 : 404 };
    },
    async () => {},
  );
  assert.equal(found.sourceFolder, '2018h');
  assert.deepEqual(calls, ['2018', '2018y', '2018f1', '2018h']);
  const refused = await findDeclaration(
    '2018',
    'a.xml',
    folders,
    async (folder) => ({ status: folder === '2018' ? 403 : 404 }),
    async () => {},
  );
  assert.equal(refused.status, 403, 'a later 404 never erases an unresolved refusal');
});

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
