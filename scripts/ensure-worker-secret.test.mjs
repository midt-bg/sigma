import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ensureSecret, generateKey } from './ensure-worker-secret.mjs';

// A recording fake: `secrets` is the worker's current secret list; put appends to it.
function fake({ secrets = [], listThrows, listReturns, putThrows } = {}) {
  const calls = { list: [], put: [] };
  const listSecrets = async (workerName) => {
    calls.list.push(workerName);
    if (listThrows) throw new Error(listThrows);
    if (listReturns !== undefined) return listReturns;
    return secrets;
  };
  const putSecret = async (workerName, name, value) => {
    calls.put.push({ workerName, name, value });
    if (putThrows) throw new Error(putThrows);
    secrets.push({ name });
  };
  return { listSecrets, putSecret, calls };
}

const BASE = { name: 'ASSISTANT_HMAC_KEY', workerName: 'sigma-web' };

describe('ensureSecret', () => {
  it('generates and puts when the secret is absent', async () => {
    const { listSecrets, putSecret, calls } = fake({ secrets: [{ name: 'OTHER' }] });
    const result = await ensureSecret({
      ...BASE,
      listSecrets,
      putSecret,
      generate: () => 'deadbeef',
    });
    assert.deepEqual(result, { action: 'created' });
    assert.equal(calls.put.length, 1);
    assert.deepEqual(calls.put[0], {
      workerName: 'sigma-web',
      name: 'ASSISTANT_HMAC_KEY',
      value: 'deadbeef',
    });
  });

  it('keeps an existing secret and never overwrites (stability across redeploys)', async () => {
    const { listSecrets, putSecret, calls } = fake({ secrets: [{ name: 'ASSISTANT_HMAC_KEY' }] });
    const result = await ensureSecret({
      ...BASE,
      listSecrets,
      putSecret,
      generate: () => assert.fail('must not generate when the secret already exists'),
    });
    assert.deepEqual(result, { action: 'kept' });
    assert.equal(calls.put.length, 0);
  });

  it('fails OPEN when the secret list errors — skips without putting', async () => {
    const { listSecrets, putSecret, calls } = fake({ listThrows: 'wrangler exploded' });
    const result = await ensureSecret({
      ...BASE,
      listSecrets,
      putSecret,
      generate: () => assert.fail('must not generate when the list failed'),
    });
    assert.equal(result.action, 'skipped');
    assert.match(result.reason, /wrangler exploded/);
    assert.equal(calls.put.length, 0);
  });

  it('fails OPEN when the list output is not an array (malformed wrangler JSON)', async () => {
    const { listSecrets, putSecret, calls } = fake({ listReturns: { unexpected: true } });
    const result = await ensureSecret({ ...BASE, listSecrets, putSecret, generate: () => 'x' });
    assert.equal(result.action, 'skipped');
    assert.equal(calls.put.length, 0);
  });

  it('propagates a put failure so a required key cannot silently go unset', async () => {
    const { listSecrets, putSecret } = fake({ secrets: [], putThrows: 'put denied' });
    await assert.rejects(
      () => ensureSecret({ ...BASE, listSecrets, putSecret, generate: () => 'x' }),
      /put denied/,
    );
  });

  it('requires a secret name and a worker name', async () => {
    const { listSecrets, putSecret } = fake();
    await assert.rejects(
      () => ensureSecret({ name: '', workerName: 'w', listSecrets, putSecret }),
      /a <secret-name> is required/,
    );
    await assert.rejects(
      () => ensureSecret({ name: 'K', workerName: '', listSecrets, putSecret }),
      /SIGMA_WEB_NAME \(worker name\) is required/,
    );
  });
});

describe('generateKey', () => {
  it('returns a fresh 256-bit key (64 lowercase hex chars) each call', () => {
    const a = generateKey();
    const b = generateKey();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.match(b, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b);
  });
});
