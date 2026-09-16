import { afterEach, expect, it, vi } from 'vitest';
import {
  parseRegistryXml,
  registryClient,
  registryDayBoundary,
  registryDay,
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

it('searches holders by name on either generation of the service, normalised to one shape', async () => {
  const hit = { uic: '000000001', companyName: 'АЛФА', fieldIdent: '00190', name: 'ИВАН ПЕТРОВ' };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 400 }))
    .mockResolvedValueOnce(Response.json({ total: 101, items: [hit] }))
    .mockResolvedValueOnce(Response.json({ total: 101, items: [] }));
  vi.stubGlobal('fetch', fetch);
  const c = registryClient({ baseUrl: 'https://registry.test' });
  const first = await c.holdersNamed(' Иван Петров ');
  expect(first).toEqual({ items: [hit], total: 101, hasMore: true });
  expect(new URL(fetch.mock.calls[0]?.[0]).pathname).toBe('/deeds/search');
  const legacy = new URL(fetch.mock.calls[1]?.[0]);
  expect(legacy.pathname).toBe('/deeds/fields/summary');
  expect(Object.fromEntries(legacy.searchParams)).toEqual({
    name: 'Иван Петров',
    page: '1',
    pageSize: '100',
  });
  expect((await c.holdersNamed('Иван Петров', 2)).hasMore).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(3); // the old route is remembered

  const current = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        total: 1,
        hasMore: false,
        items: [{ ...hit, fieldIdent: undefined, field: '00190', role: 'Partner' }],
      }),
    );
  vi.stubGlobal('fetch', current);
  const fresh = registryClient({ baseUrl: 'https://registry.test' });
  expect(await fresh.holdersNamed('Иван Петров')).toEqual({
    items: [hit],
    total: 1,
    hasMore: false,
  });
  expect(Object.fromEntries(new URL(current.mock.calls[0]?.[0]).searchParams)).toEqual({
    target: 'Иван Петров',
    limit: '100',
    offset: '0',
  });
  await expect(fresh.holdersNamed('')).rejects.toThrow('invalid search name');
});
