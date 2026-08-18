import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ensureNamespace, listNamespaces } from './ensure-kv-namespace.mjs';

const CREDS = { accountId: 'acct', token: 'tok' };
const ok = (result) => ({ ok: true, status: 200, json: async () => ({ success: true, result }) });

// Build a fake fetch that records calls and answers list/create from a mutable namespace store.
function fakeCf({ pages = [[]], onCreate } = {}) {
  const calls = [];
  let listCall = 0;
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET' });
    if ((opts.method ?? 'GET') === 'GET') {
      // Return an EMPTY page past the supplied set — not a clamp to the last page. A clamp would feed
      // duplicate results if the implementation ever over-fetched (e.g. a `< PER_PAGE` → `<= PER_PAGE`
      // regression), silently hiding the bug instead of failing the test.
      return ok(pages[listCall++] ?? []);
    }
    return onCreate(JSON.parse(opts.body));
  };
  return { fetchImpl, calls };
}

describe('ensureNamespace', () => {
  it('reuses an existing namespace and never creates', async () => {
    const { fetchImpl, calls } = fakeCf({
      pages: [[{ id: 'existing-id', title: 'sigma-dedup-dev' }]],
      onCreate: () => assert.fail('must not create when the title already exists'),
    });
    const id = await ensureNamespace({ ...CREDS, title: 'sigma-dedup-dev', fetchImpl });
    assert.equal(id, 'existing-id');
    assert.ok(calls.every((c) => c.method === 'GET'));
  });

  it('creates when absent and returns the new id', async () => {
    const { fetchImpl, calls } = fakeCf({
      pages: [[{ id: 'other', title: 'unrelated' }]],
      onCreate: (body) => {
        assert.equal(body.title, 'sigma-dedup-staging');
        return ok({ id: 'fresh-id', title: body.title });
      },
    });
    const id = await ensureNamespace({ ...CREDS, title: 'sigma-dedup-staging', fetchImpl });
    assert.equal(id, 'fresh-id');
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  });

  it('paginates the list so a match on a later page is still found (no duplicate create)', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, title: `t${i}` }));
    const { fetchImpl } = fakeCf({
      pages: [page1, [{ id: 'wanted', title: 'sigma-dedup-prod' }]],
      onCreate: () => assert.fail('should have found the namespace on page 2'),
    });
    const id = await ensureNamespace({ ...CREDS, title: 'sigma-dedup-prod', fetchImpl });
    assert.equal(id, 'wanted');
  });

  it('reuses the first when duplicates share a title, never creating another', async () => {
    const { fetchImpl } = fakeCf({
      pages: [
        [
          { id: 'first', title: 'sigma-dedup-dev' },
          { id: 'second', title: 'sigma-dedup-dev' },
        ],
      ],
      onCreate: () => assert.fail('must not create a third duplicate'),
    });
    const id = await ensureNamespace({ ...CREDS, title: 'sigma-dedup-dev', fetchImpl });
    assert.equal(id, 'first');
  });

  it('requires credentials and a title', async () => {
    await assert.rejects(
      () => ensureNamespace({ token: 'tok', title: 't', fetchImpl: () => assert.fail() }),
      /CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required/,
    );
    await assert.rejects(
      () => ensureNamespace({ ...CREDS, title: '', fetchImpl: () => assert.fail() }),
      /a namespace <title> is required/,
    );
  });

  it('surfaces a Cloudflare API error instead of masking it', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        success: false,
        errors: [{ code: 10000, message: 'Authentication error' }],
      }),
    });
    await assert.rejects(
      () => ensureNamespace({ ...CREDS, title: 'sigma-dedup-dev', fetchImpl }),
      /10000 Authentication error/,
    );
  });
});

describe('listNamespaces', () => {
  it('flattens all pages into { id, title } records', async () => {
    const { fetchImpl } = fakeCf({
      pages: [
        Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, title: `a${i}`, extra: 'ignored' })),
        [{ id: 'z', title: 'z' }],
      ],
    });
    const all = await listNamespaces({ ...CREDS, fetchImpl });
    assert.equal(all.length, 101);
    assert.deepEqual(all[100], { id: 'z', title: 'z' });
  });
});
