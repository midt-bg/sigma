import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Loader contract for /quality: which query params reach getQuality (and in what validated shape),
// and — critically — which errors are swallowed into the "not yet derived" empty state versus
// rethrown. Only a missing contract_features table is the expected pre-derive condition; any other
// failure, including a genuine typo'd-table bug, must surface.
const q = vi.hoisted(() => ({
  getQuality: vi.fn(),
  getDb: vi.fn((env: { DB: unknown }) => env.DB),
}));
vi.mock('@sigma/db', () => q);

import { loader } from './quality';

const context = { cloudflare: { env: { DB: {} } } };
const run = (qs = '') =>
  loader({
    request: new Request(`https://sigma.test/quality${qs}`),
    context,
  } as unknown as Parameters<typeof loader>[0]);
const lastArgs = () => q.getQuality.mock.calls.at(-1)![1];

describe('/quality loader', () => {
  beforeEach(() => {
    q.getQuality.mockReset().mockResolvedValue({ marker: 'data' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('passes defaults when no params are given', async () => {
    expect(await run()).toEqual({ data: { marker: 'data' } });
    const a = lastArgs();
    expect(a.grain).toBeUndefined();
    expect(a.sort).toBe('score');
    expect(a.contractSort).toBe('score');
    expect(a.sel).toBeNull();
    expect(a.contractId).toBeNull();
    expect(a.band).toBeNull();
  });

  it('forwards grain, sort, csort, sel, contract and band', async () => {
    await run('?grain=supplier&sort=contracts&csort=value&sel=eik:1&contract=c:9&band=good');
    expect(lastArgs()).toMatchObject({
      grain: 'supplier',
      sort: 'contracts',
      contractSort: 'value',
      sel: 'eik:1',
      contractId: 'c:9',
      band: 'good',
    });
  });

  it('drops an unknown grain and unknown sort keys to their defaults', async () => {
    await run('?grain=drop_table&sort=x&csort=y');
    const a = lastArgs();
    expect(a.grain).toBeUndefined();
    expect(a.sort).toBe('score');
    expect(a.contractSort).toBe('score');
  });

  it('drops hostile sel/contract/band values to null instead of forwarding them', async () => {
    await run(`?sel=${encodeURIComponent("x' OR 1=1 --")}&band=%27%3B&contract=..%2F..`);
    const a = lastArgs();
    expect(a.sel).toBeNull();
    expect(a.band).toBeNull();
    expect(a.contractId).toBeNull();
  });

  it('rejects an out-of-set band and an over-long key, accepts histogram bins', async () => {
    await run(`?band=20&sel=${'a'.repeat(200)}`);
    expect(lastArgs().band).toBeNull();
    expect(lastArgs().sel).toBeNull();
    await run('?band=19&sel=123456789');
    expect(lastArgs()).toMatchObject({ band: '19', sel: '123456789' });
  });

  it('parses the ranking direction and avg-index range through the shared controls', async () => {
    await run('?rdir=desc&rfrom=20&rto=60');
    expect(lastArgs()).toMatchObject({ dir: 'desc', rankFrom: 20, rankTo: 60 });
  });

  it('swallows a missing contract_features table into the empty state', async () => {
    q.getQuality.mockRejectedValue(
      new Error('D1_ERROR: no such table: contract_features: SQLITE_ERROR'),
    );
    expect(await run()).toEqual({ data: null });
    expect(console.warn).toHaveBeenCalled();
  });

  it('rethrows a different missing table — a typo\'d table name is a real bug, not "not derived yet"', async () => {
    const boom = new Error('D1_ERROR: no such table: contract_featurez: SQLITE_ERROR');
    q.getQuality.mockRejectedValue(boom);
    await expect(run()).rejects.toBe(boom);
    expect(console.error).toHaveBeenCalled();
  });

  it('rethrows unrelated failures', async () => {
    const boom = new Error('D1_ERROR: database is locked');
    q.getQuality.mockRejectedValue(boom);
    await expect(run()).rejects.toBe(boom);
  });
});
