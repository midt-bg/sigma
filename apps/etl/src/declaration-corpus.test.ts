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
  expect(remove).not.toHaveBeenCalled();
  expect((await call('.corpus-complete.json', { method: 'DELETE' })).status).toBe(204);
  expect(remove).toHaveBeenCalledWith('declarations/corpus-v2/.corpus-complete.json');
});
