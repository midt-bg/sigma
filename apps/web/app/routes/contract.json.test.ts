import { describe, expect, it, vi } from 'vitest';

const { getContractMock } = vi.hoisted(() => ({ getContractMock: vi.fn() }));
vi.mock('@sigma/db', () => ({
  getContract: getContractMock,
  contractIdFromSlug: (slug: string) => slug,
  getDb: (env: unknown) => env,
}));

import { loader } from './contract.json';

const call = (id: string) =>
  loader({
    params: { id: `${id}.json` },
    context: { cloudflare: { env: {} } },
  } as unknown as Parameters<typeof loader>[0]) as Promise<Response>;

describe('contract JSON export', () => {
  it('rounds every …Eur amount to the cent and leaves other numbers alone', async () => {
    getContractMock.mockResolvedValueOnce({
      id: 'c:1',
      bids: 3,
      value: { currentEur: 81806.70099139496, estimatedEur: null, steps: [{ deltaEur: -0.004 }] },
    });
    const res = await call('c:1');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.json()).toEqual({
      id: 'c:1',
      bids: 3,
      value: { currentEur: 81806.7, estimatedEur: null, steps: [{ deltaEur: 0 }] },
    });
  });

  it('answers an unknown id with a 404 JSON body that names its charset', async () => {
    getContractMock.mockResolvedValueOnce(null);
    const res = await call('c:missing');
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
