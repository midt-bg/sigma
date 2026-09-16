import { expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
import { DeclarationCorpus } from './declaration-corpus';

it('streams checksummed objects through the private R2 binding and confines every operation', async () => {
  const put = vi.fn(async () => ({}));
  const get = vi.fn(async () => ({
    body: new Response('<xml/>').body,
    customMetadata: { sha256: 'a'.repeat(64) },
  }));
  const list = vi.fn(async () => ({
    objects: [
      { key: 'declarations/corpus-v2/2025/a.xml', customMetadata: { sha256: 'a'.repeat(64) } },
    ],
    truncated: true,
    cursor: 'next',
  }));
  const remove = vi.fn();
  const worker = new DeclarationCorpus(
    {} as never,
    { DECLARATIONS_CORPUS: { put, get, list, delete: remove } } as never,
  );
  const call = (path: string, init?: RequestInit) =>
    worker.fetch(new Request('http://declarations.r2/' + path, init));
  expect((await worker.fetch(new Request('https://public.example/2025/a.xml'))).status).toBe(404);
  expect(
    (
      await call('2025/a.xml', {
        method: 'PUT',
        body: '<xml/>',
        headers: { 'x-corpus-sha256': 'a'.repeat(64) },
      })
    ).status,
  ).toBe(204);
  expect(put).toHaveBeenCalledWith(
    'declarations/corpus-v2/2025/a.xml',
    expect.anything(),
    expect.objectContaining({ sha256: 'a'.repeat(64) }),
  );
  expect(await (await call('2025/a.xml')).text()).toBe('<xml/>');
  expect(await (await call('?prefix=2025%2F&cursor=before')).json()).toMatchObject({
    truncated: true,
    cursor: 'next',
  });
  expect(list).toHaveBeenCalledWith(
    expect.objectContaining({
      prefix: 'declarations/corpus-v2/2025/',
      cursor: 'before',
      include: ['customMetadata'],
    }),
  );
  expect((await call('2025/a.xml', { method: 'DELETE' })).status).toBe(405);
  expect((await call('2025/a.xml', { method: 'PUT', body: 'bad' })).status).toBe(400);
  expect((await call('?prefix=other/')).status).toBe(400);
  expect((await call('secret')).status).toBe(400);
  const eventKey = 'fetch-events/00000000-0000-4000-8000-000000000000/1.json';
  expect(
    (
      await call(eventKey, {
        method: 'PUT',
        body: '{"status":403}',
        headers: { 'x-corpus-sha256': 'a'.repeat(64) },
      })
    ).status,
  ).toBe(204);
  expect(put).toHaveBeenLastCalledWith(
    'declarations/corpus-v2/' + eventKey,
    expect.anything(),
    expect.objectContaining({ sha256: 'a'.repeat(64) }),
  );
  expect((await call(eventKey, { method: 'DELETE' })).status).toBe(405);
  expect((await call('fetch-events/invalid/1.json')).status).toBe(400);
  expect(remove).not.toHaveBeenCalled();
  expect((await call('.corpus-complete.json', { method: 'DELETE' })).status).toBe(204);
  expect(remove).toHaveBeenCalledWith('declarations/corpus-v2/.corpus-complete.json');
});

it('lists a last page without a cursor, and serves missing or unchecksummed objects honestly', async () => {
  const list = vi.fn(async () => ({
    objects: [{ key: 'declarations/corpus-v2/2024/b.xml' }],
    truncated: false,
  }));
  const get = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ body: new Response('<b/>').body });
  const worker = new DeclarationCorpus(
    {} as never,
    { DECLARATIONS_CORPUS: { list, get } } as never,
  );
  const call = (path: string) => worker.fetch(new Request('http://declarations.r2/' + path));
  // No prefix is no listing: the whole corpus is never enumerated in one call.
  expect((await call('')).status).toBe(400);
  expect(list).not.toHaveBeenCalled();
  expect(await (await call('?prefix=2024%2F')).json()).toEqual({
    objects: [{ key: '2024/b.xml' }],
    truncated: false,
  });
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ cursor: undefined }));
  expect((await call('2024/a.xml')).status).toBe(404);
  const res = await call('2024/b.xml');
  expect(res.headers.get('x-corpus-sha256')).toBe('');
  expect(await res.text()).toBe('<b/>');
});
