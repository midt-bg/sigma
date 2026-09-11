// The register client: what a partida read can come back as, and what the daily changes feed yields. The
// contract that matters: a 404 is „no partida", a 429 is waited out as the API asks, and no other failure
// is ever turned into „absent".
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegistryError, registryClient, retryAfterMs, type RegistryDeed } from './registry';

const BASE = 'http://registry.test';
const partida = (uic: string): RegistryDeed => {
  const body = {
    uic,
    name: 'ПРИМЕР ЕООД',
    status: 'N',
    guid: 'g',
    legalForm: 'EOOD',
    subDeeds: [],
  };
  return { deed: body, deedActualState: body };
};
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

afterEach(() => vi.unstubAllGlobals());

function stub(...answers: (Response | Error)[]) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const a = answers.shift();
    if (!a) throw new Error('unexpected request');
    if (a instanceof Error) throw a;
    return a;
  });
  return calls;
}
const sleeps: number[] = [];
const client = (maxAttempts = 3) =>
  registryClient({ baseUrl: `${BASE}/`, maxAttempts, sleep: async (ms) => void sleeps.push(ms) });

describe('registryClient.deed', () => {
  it('reads a partida by its ЕИК', async () => {
    const calls = stub(json(partida('101010101')));
    const r = await client().deed('101010101');
    expect(r).toEqual({ status: 'ok', deed: partida('101010101') });
    expect(calls).toEqual([`${BASE}/deeds/101010101`]);
  });

  it('says a partida is absent only on a 404', async () => {
    stub(new Response('{}', { status: 404 }));
    expect(await client().deed('101010101')).toEqual({ status: 'absent' });
  });

  it('waits out a 429 for as long as the API asks, then reads', async () => {
    sleeps.length = 0;
    stub(
      new Response('', { status: 429, headers: { 'retry-after': '2' } }),
      json(partida('101010101')),
    );
    expect((await client().deed('101010101')).status).toBe('ok');
    expect(sleeps).toEqual([2000]);
  });

  it('backs off on a 5xx or a network failure, and fails loudly once the attempts are spent', async () => {
    sleeps.length = 0;
    stub(new Response('', { status: 503 }), new Error('reset'), new Response('', { status: 500 }));
    await expect(client().deed('101010101')).rejects.toThrow(RegistryError);
    expect(sleeps).toEqual([1000, 2000]);
    stub(new Error('reset'));
    await expect(client(1).deed('101010101')).rejects.toThrow(/request failed/);
  });

  it('never reads anything but a nine-digit partida, and refuses an answer for another one', async () => {
    const calls = stub();
    await expect(client().deed('12345')).rejects.toThrow(/not a partida/);
    expect(calls).toEqual([]);
    stub(json(partida('999999999')));
    await expect(client().deed('101010101')).rejects.toThrow(/no partida 101010101/);
  });

  it('refuses a redirect to another host and any other status', async () => {
    const moved = json(partida('101010101'));
    Object.defineProperty(moved, 'url', { value: 'http://elsewhere.test/deeds/101010101' });
    stub(moved);
    await expect(client().deed('101010101')).rejects.toThrow(/redirected/);
    stub(new Response('', { status: 400 }));
    await expect(client().deed('101010101')).rejects.toThrow(/answered 400/);
  });
});

describe('registryClient.changedUics', () => {
  it('walks the day’s pages and names every partida once', async () => {
    const change = (uic: string) => ({
      uic,
      companyName: '',
      entryNumber: '1',
      entryDate: '',
      fieldIdent: '00070',
      operation: 'Add',
    });
    const calls = stub(
      json({ items: [change('111111111'), change('222222222')], hasMore: true }),
      json({ items: [change('111111111'), change('33')], hasMore: false }),
    );
    expect(await client().changedUics('2026-09-09')).toEqual(['111111111', '222222222']);
    expect(calls[0]).toBe(`${BASE}/deeds/changes?date=2026-09-09&by=loaded&limit=1000&offset=0`);
    expect(calls[1]).toContain('offset=2');
  });

  it('refuses a malformed day and a feed that is not there', async () => {
    await expect(client().changes('9 септември')).rejects.toThrow(/not a day/);
    stub(new Response('', { status: 404 }));
    await expect(client().changes('2026-09-09')).rejects.toThrow(/no changes feed/);
    stub(json({}));
    expect(await client().changes('2026-09-09')).toEqual({ items: [], hasMore: false });
  });
});

describe('retryAfterMs', () => {
  it('reads seconds or a date, caps the wait, and ignores what it cannot read', () => {
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(retryAfterMs('9999')).toBe(120_000);
    expect(retryAfterMs('soon')).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });
});
