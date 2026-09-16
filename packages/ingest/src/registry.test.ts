import { afterEach, expect, it, vi } from 'vitest';
import {
  parseRegistryXml,
  registryClient,
  registryDayBoundary,
  registryDay,
  RegistryError,
  retryAfterMs,
} from './registry';
const XML = `<DeedResult><Deed UIC="000000001" CompanyName="ТЕСТ" LegalForm="EOOD"><SubDeed SubUIC="01"><Managers FieldIdent="00070" FieldOperation="Erase" FieldEntryNumber="001" FieldEntryDate="2026-09-01T10:00:00.123"><Manager><Person><Indent>00abc</Indent><Name>Тест</Name></Person></Manager></Managers></SubDeed></Deed><DeedActualState UIC="000000001" /></DeedResult>`;
afterEach(() => vi.unstubAllGlobals());
it('normalizes XML attributes, history, repeated fields and original identifiers', () => {
  const d = parseRegistryXml(XML, '000000001');
  expect(d.deed.subDeeds[0]?.fields[0]).toMatchObject({
    operation: 'Erase',
    entryNumber: '001',
    entryDate: '2026-09-01T10:00:00.123',
    value: { Manager: { Person: { Indent: '00abc' } } },
  });
  expect(d.deedActualState.subDeeds).toEqual([]);
  expect(() => parseRegistryXml(XML, '999999999')).toThrow();
  expect(() => parseRegistryXml('<html>error</html>', '000000001')).toThrow();
  expect(() => parseRegistryXml('<!DOCTYPE x>' + XML, '000000001')).toThrow();
});
it('uses the published XML route; only 404 means absent', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(XML))
    .mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce(new Response('', { status: 500 }));
  vi.stubGlobal('fetch', fetch);
  const c = registryClient({ baseUrl: 'https://registry.test' });
  expect((await c.deed('000000001')).status).toBe('ok');
  expect(await c.deed('000000001')).toEqual({ status: 'absent' });
  await expect(c.deed('000000001')).rejects.toThrow('500');
  expect(fetch.mock.calls[0]?.[0]).toBe('https://registry.test/deeds/000000001');
});
it('reads portal pages of 25 without treating later Count:0 as an empty day', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify([
          { uic: '000000001', date: '2026-09-01T10:00:00', companyFullName: 'Тест' },
        ]),
        { headers: { Count: '0' } },
      ),
    );
  vi.stubGlobal('fetch', fetch);
  const page = await registryClient({ baseUrl: 'https://registry.test' }).changes('2026-09-01', 2);
  expect(page).toMatchObject({ hasMore: false, total: null, items: [{ uic: '000000001' }] });
  const url = new URL(fetch.mock.calls[0]?.[0]);
  expect(url.searchParams.get('pageSize')).toBe('25');
  expect(url.searchParams.has('by')).toBe(false);
  expect(url.searchParams.get('dateFrom')).toBe('2026-09-01T00:00:00+03:00');
});
it('rejects redirects for both registry sources with a Workers-supported fetch mode', async () => {
  const fetch = vi.fn(
    async () => new Response(null, { status: 302, headers: { Location: 'https://other.test' } }),
  );
  vi.stubGlobal('fetch', fetch);
  const c = registryClient({ baseUrl: 'https://registry.test' });
  await expect(c.deed('000000001')).rejects.toMatchObject({ status: 302 });
  await expect(c.changes('2026-09-01')).rejects.toMatchObject({ status: 302 });
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const call of fetch.mock.calls)
    expect(call).toEqual([expect.any(String), expect.objectContaining({ redirect: 'manual' })]);
});
it('refuses malformed list responses and preserves Retry-After for durable retry', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '600' } })),
  );
  const c = registryClient({ baseUrl: 'https://registry.test' });
  await expect(c.changes('2026-09-01')).rejects.toThrow('invalid portal');
  await expect(c.changes('2026-09-01')).rejects.toMatchObject({ status: 429, retryMs: 600000 });
  expect(retryAfterMs('600')).toBe(600000);
});
it('uses Bulgarian calendar days including both DST transitions', () => {
  expect(registryDay(new Date('2026-09-01T22:00:00Z'))).toBe('2026-09-02');
  expect(registryDayBoundary('2026-03-29')).toBe('2026-03-29T00:00:00+02:00');
  expect(registryDayBoundary('2026-03-29', true)).toBe('2026-03-29T23:59:59.999+03:00');
  expect(registryDayBoundary('2026-10-25')).toBe('2026-10-25T00:00:00+03:00');
  expect(registryDayBoundary('2026-10-25', true)).toBe('2026-10-25T23:59:59.999+02:00');
});
it('passes over sub-partida children that are not register fields', () => {
  const xml = XML.replace(
    '<SubDeed SubUIC="01">',
    '<SubDeed SubUIC="01" SubUICType="MainCircumstances"><Notes Kind="internal"><Note>x</Note></Notes><Remark>текст</Remark>',
  );
  const sub = parseRegistryXml(xml, '000000001').deed.subDeeds[0]!;
  expect(sub).toMatchObject({ subUic: '01', subUicType: 'MainCircumstances' });
  expect(sub.fields.map((f) => [f.element, f.fieldIdent])).toEqual([['Managers', '00070']]);
});
it('refuses a malformed or impossible registry day', () => {
  for (const day of ['2026-9-1', '01.09.2026', '2026-02-30', '2026-04-31'])
    expect(() => registryDayBoundary(day)).toThrow(`not a day: ${day}`);
});
it('reads Retry-After as seconds or an HTTP date, and ignores anything else or already past', () => {
  const now = Date.parse('2026-09-01T10:00:00Z');
  expect(retryAfterMs('Tue, 01 Sep 2026 10:05:00 GMT', now)).toBe(300_000);
  expect(retryAfterMs('0', now)).toBe(0);
  expect(retryAfterMs('Tue, 01 Sep 2026 09:55:00 GMT', now)).toBeNull();
  expect(retryAfterMs('-5', now)).toBeNull();
  expect(retryAfterMs('скоро', now)).toBeNull();
  expect(retryAfterMs('  ', now)).toBeNull();
  expect(retryAfterMs(null, now)).toBeNull();
});
it('refuses a malformed ЕИК, page or day without calling the registry', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const c = registryClient({ baseUrl: 'https://registry.test' });
  await expect(c.deed('12345')).rejects.toThrow('not a partida ЕИК: 12345');
  // A branch's 13-digit ЕИК is not a partida of its own.
  await expect(c.deed('1234567890123')).rejects.toThrow('not a partida ЕИК');
  for (const page of [0, -1, 1.5, Number.NaN])
    await expect(c.changes('2026-09-01', page)).rejects.toThrow('invalid portal page');
  await expect(c.changes('2026-02-30')).rejects.toThrow('not a day: 2026-02-30');
  expect(fetch).not.toHaveBeenCalled();
});
it('retries a request that fails with backoff and gives up after the last attempt', async () => {
  const sleep = vi.fn(async () => {});
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('fetch failed'))
    .mockRejectedValueOnce(new TypeError('fetch failed'))
    .mockResolvedValueOnce(new Response(XML));
  vi.stubGlobal('fetch', fetch);
  const c = registryClient({ baseUrl: 'https://registry.test//', sleep });
  expect(await c.deed('000000001')).toMatchObject({
    status: 'ok',
    deed: { deed: { uic: '000000001' } },
  });
  expect(sleep.mock.calls).toEqual([[1000], [2000]]);
  expect(fetch.mock.calls.map((call) => call[0])).toEqual(
    Array(3).fill('https://registry.test/deeds/000000001'),
  );

  sleep.mockClear();
  fetch.mockClear().mockRejectedValue(new TypeError('fetch failed'));
  // A transport failure carries no status and no server-requested delay.
  await expect(c.deed('000000001')).rejects.toMatchObject({
    message: 'registry request failed: TypeError: fetch failed',
    status: undefined,
    retryMs: undefined,
  });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(sleep.mock.calls).toEqual([[1000], [2000]]);
});
it('makes a single attempt when told to', async () => {
  const sleep = vi.fn(async () => {});
  const fetch = vi.fn().mockRejectedValue(new Error('timeout'));
  vi.stubGlobal('fetch', fetch);
  const c = registryClient({ baseUrl: 'https://registry.test', maxAttempts: 1, sleep });
  await expect(c.changes('2026-09-01')).rejects.toThrow('registry request failed: Error: timeout');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});
it('waits between attempts on its own timer when no sleep is given', async () => {
  vi.useFakeTimers();
  try {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const lookup = registryClient({ baseUrl: 'https://registry.test' }).deed('000000001');
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(lookup).resolves.toEqual({ status: 'absent' });
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
it('asks a rate-limited caller to wait three minutes unless the registry names a delay', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('', { status: 503 })),
  );
  const c = registryClient({ baseUrl: 'https://registry.test' });
  await expect(c.deed('000000001')).rejects.toMatchObject({ status: 429, retryMs: 180_000 });
  await expect(c.deed('000000001')).rejects.toMatchObject({ status: 503, retryMs: 30_000 });
});
it('takes the day total from the first page only when the portal gives a count', async () => {
  const entries = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      uic: String(100000000 + i),
      date: `2026-09-01T10:${String(i).padStart(2, '0')}:00`,
      ...(i ? { companyFullName: `ФИРМА ${i}` } : {}),
    }));
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(entries(25)), { headers: { Count: '30' } }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(entries(5))))
      .mockResolvedValueOnce(new Response('[]', { headers: { Count: 'unknown' } })),
  );
  const c = registryClient({ baseUrl: 'https://registry.test' });
  const first = await c.changes('2026-09-01');
  expect(first).toMatchObject({ total: 30, hasMore: true });
  expect(first.items).toHaveLength(25);
  expect(first.items.slice(0, 2)).toEqual([
    { uic: '100000000', entryDate: '2026-09-01T10:00:00', companyName: '' },
    { uic: '100000001', entryDate: '2026-09-01T10:01:00', companyName: 'ФИРМА 1' },
  ]);
  expect(await c.changes('2026-09-01')).toMatchObject({ total: null, hasMore: false });
  expect(await c.changes('2026-09-01')).toEqual({ items: [], total: null, hasMore: false });
});
it('refuses a day the portal does not know and an entry list it cannot trust', async () => {
  const entry = { uic: '000000001', date: '2026-09-01T10:00:00', companyFullName: 'Тест' };
  const list = (body: unknown) => new Response(JSON.stringify(body));
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(list(Array(26).fill(entry)))
      .mockResolvedValueOnce(list([{ ...entry, uic: '12345' }]))
      .mockResolvedValueOnce(list([{ ...entry, date: 20260901 }]))
      .mockResolvedValueOnce(list([{ ...entry, date: '2026-09-02T00:00:00' }]))
      .mockResolvedValueOnce(list([{ ...entry, date: '2026-09-01T25:00:00' }]))
      .mockResolvedValueOnce(list(['000000001'])),
  );
  const c = registryClient({ baseUrl: 'https://registry.test' });
  await expect(c.changes('2026-09-01')).rejects.toThrow('portal has no entry list for 2026-09-01');
  await expect(c.changes('2026-09-01')).rejects.toThrow('invalid portal entry list');
  for (let i = 0; i < 4; i++)
    await expect(c.changes('2026-09-01')).rejects.toThrow(/^invalid portal entry$/);
  await expect(c.changes('2026-09-01')).rejects.toThrow('invalid registry object');
});
it('rejects an impossible calendar day as a register error before any request', async () => {
  const fetchFn = vi.fn();
  vi.stubGlobal('fetch', fetchFn);
  const c = registryClient({ baseUrl: 'https://registry.test' });
  for (const day of ['2026-13-01', '2026-01-00', '2026-01-32', '2026-02-30']) {
    expect(() => registryDayBoundary(day)).toThrow(RegistryError);
    expect(() => registryDayBoundary(day)).toThrow(`not a day: ${day}`);
    await expect(c.changes(day)).rejects.toThrow(RegistryError);
  }
  expect(fetchFn).not.toHaveBeenCalled();
});
