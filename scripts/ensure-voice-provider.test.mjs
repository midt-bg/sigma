import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureGateway,
  ensureCustomProvider,
  dryRunFetch,
  GATEWAY_ID,
  PROVIDER_SLUG,
} from './ensure-voice-provider.mjs';

const CREDS = { accountId: 'acct', token: 'tok' };
const okResult = (result) => ({
  ok: true,
  status: 200,
  json: async () => ({ success: true, result }),
});

// Records every call so tests can assert exactly which mutations fired.
function recorder(handler) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    return handler({ url, method, body: opts.body ? JSON.parse(opts.body) : undefined });
  };
  return { fetchImpl, calls };
}
const posts = (calls) => calls.filter((c) => c.method === 'POST');

describe('ensureGateway', () => {
  it('no-ops when the gateway already exists', async () => {
    const { fetchImpl, calls } = recorder(() => okResult([{ id: GATEWAY_ID }]));
    const id = await ensureGateway({ ...CREDS, fetchImpl });
    assert.equal(id, GATEWAY_ID);
    assert.equal(posts(calls).length, 0);
  });
  it('creates the gateway when absent', async () => {
    const { fetchImpl, calls } = recorder(({ method }) =>
      method === 'GET' ? okResult([{ id: 'other' }]) : okResult({ id: GATEWAY_ID }),
    );
    await ensureGateway({ ...CREDS, fetchImpl });
    assert.equal(posts(calls).length, 1);
    assert.equal(posts(calls)[0].body.id, GATEWAY_ID);
  });
});

describe('ensureCustomProvider', () => {
  it('reuses an existing provider and never re-writes the secret', async () => {
    const { fetchImpl, calls } = recorder(() =>
      okResult([{ id: 'p1', slug: PROVIDER_SLUG, base_url: 'https://api.bggpt.ai' }]),
    );
    const id = await ensureCustomProvider({ ...CREDS, apiKey: 'k', fetchImpl });
    assert.equal(id, 'p1');
    assert.equal(posts(calls).length, 0);
  });
  it('creates with a stored Authorization header when a key is supplied', async () => {
    const { fetchImpl, calls } = recorder(({ method }) =>
      method === 'GET' ? okResult([]) : okResult({ id: 'new' }),
    );
    await ensureCustomProvider({ ...CREDS, apiKey: 'secret', fetchImpl });
    const body = posts(calls)[0].body;
    assert.equal(body.slug, PROVIDER_SLUG);
    assert.equal(body.base_url, 'https://api.bggpt.ai');
    assert.equal(body.headers.Authorization, 'Bearer secret');
  });
  it('creates key-less and warns when no key is supplied', async () => {
    let warned = '';
    const { fetchImpl, calls } = recorder(({ method }) =>
      method === 'GET' ? okResult([]) : okResult({ id: 'new' }),
    );
    await ensureCustomProvider({ ...CREDS, fetchImpl, warn: (m) => (warned = m) });
    assert.equal(posts(calls)[0].body.headers, null);
    assert.match(warned, /per-request-auth/);
  });
});

describe('error surfacing', () => {
  it('propagates a Cloudflare errors[] and requires creds', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        success: false,
        errors: [{ code: 10000, message: 'Authentication error' }],
      }),
    });
    await assert.rejects(
      () => ensureGateway({ ...CREDS, fetchImpl }),
      /10000 Authentication error/,
    );
    await assert.rejects(
      () => ensureGateway({ token: 'tok', fetchImpl: () => assert.fail() }),
      /CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required/,
    );
  });
  it('propagates a flat {error} shape too', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ success: false, error: 'Invalid provider' }),
    });
    await assert.rejects(() => ensureCustomProvider({ ...CREDS, fetchImpl }), /Invalid provider/);
  });
});

describe('dryRunFetch — no secret in the plan output', () => {
  it('masks the Authorization bearer token in the logged mutation body', async () => {
    const logs = [];
    const impl = dryRunFetch(
      () => assert.fail('real fetch must not run for a mutation in dry-run'),
      (m) => logs.push(m),
    );
    const res = await impl('https://api/custom-providers', {
      method: 'POST',
      body: JSON.stringify({ slug: 'x', headers: { Authorization: 'Bearer super-secret-123' } }),
    });
    assert.equal(res.ok, true); // synthetic dry-run success, no account touched
    const out = logs.join('\n');
    assert.ok(!out.includes('super-secret-123'), 'the secret must never appear in the dry-run log');
    assert.match(out, /Bearer \*\*\*/);
  });

  it('passes GET through to the real fetch and logs nothing', async () => {
    const logs = [];
    let realCalled = false;
    const impl = dryRunFetch(
      async () => {
        realCalled = true;
        return okResult([]);
      },
      (m) => logs.push(m),
    );
    await impl('https://api/custom-providers', { method: 'GET' });
    assert.equal(realCalled, true);
    assert.equal(logs.length, 0);
  });
});
