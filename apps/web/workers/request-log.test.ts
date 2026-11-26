import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRequestLogEntry, emitRequestLog, ipHash, withRequestLog } from './request-log';

const LOG_KEY = 'local-test-log-ip-key';

function executionContext() {
  const pending: Promise<unknown>[] = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    pending.push(promise);
  });

  return {
    ctx: { waitUntil } as unknown as ExecutionContext,
    pending,
    waitUntil,
  };
}

describe('request log', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks non-empty q as present without logging the query string in path', async () => {
    const entry = await buildRequestLogEntry(
      new Request('http://local/search?q=%20test%20&sort=value'),
      { LOG_IP_KEY: LOG_KEY },
      200,
      12,
      1_700_000_000_000,
    );

    expect(entry.q_present).toBe(true);
    expect(entry.q_len).toBe(4);
    expect(entry.path).toBe('/search');
  });

  it.each(['http://local/search', 'http://local/search?q=', 'http://local/search?q=%20%09'])(
    'marks absent or blank q as not present for %s',
    async (url) => {
      const entry = await buildRequestLogEntry(
        new Request(url),
        { LOG_IP_KEY: LOG_KEY },
        200,
        7,
        1_700_000_000_000,
      );

      expect(entry.q_present).toBe(false);
      expect(entry.q_len).toBe(0);
    },
  );

  it('hashes the same IP consistently and different IPs differently', async () => {
    const first = await ipHash(
      new Request('http://local/', { headers: { 'CF-Connecting-IP': '203.0.113.10' } }),
      { LOG_IP_KEY: LOG_KEY },
    );
    const second = await ipHash(
      new Request('http://local/', { headers: { 'CF-Connecting-IP': '203.0.113.10' } }),
      { LOG_IP_KEY: LOG_KEY },
    );
    const third = await ipHash(
      new Request('http://local/', { headers: { 'CF-Connecting-IP': '203.0.113.11' } }),
      { LOG_IP_KEY: LOG_KEY },
    );

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(third).not.toBe(first);
  });

  it('logs other fields and uses null ipHash when the key is missing', async () => {
    const entry = await buildRequestLogEntry(
      new Request('http://local/contracts?q=test'),
      {},
      429,
      3,
      1_700_000_000_000,
    );

    expect(entry).toMatchObject({
      ts: '2023-11-14T22:13:20.000Z',
      ipHash: null,
      method: 'GET',
      path: '/contracts',
      status: 429,
      ms: 3,
      q_present: true,
      q_len: 4,
    });
  });

  it('emits exactly the minimal structured object', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await emitRequestLog(
      new Request('http://local/companies?q=%20abc%20', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '198.51.100.20' },
      }),
      { LOG_IP_KEY: LOG_KEY },
      201,
      9,
      1_700_000_000_000,
    );

    expect(log).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(log.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(Object.keys(entry)).toEqual([
      'level',
      'ts',
      'ipHash',
      'method',
      'path',
      'status',
      'ms',
      'q_present',
      'q_len',
      'edge',
      'degraded',
    ]);
    expect(entry).toMatchObject({
      level: 'info',
      ts: '2023-11-14T22:13:20.000Z',
      method: 'POST',
      path: '/companies',
      status: 201,
      ms: 9,
      q_present: true,
      q_len: 3,
    });
    expect(entry.ipHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('queues one log for a returned response status', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { ctx, pending, waitUntil } = executionContext();

    const response = await withRequestLog(
      new Request('http://local/ok'),
      { LOG_IP_KEY: LOG_KEY } as Env,
      ctx,
      async () => new Response(null, { status: 204 }),
    );
    await Promise.all(pending);

    expect(response.status).toBe(204);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({
      level: 'info',
      status: 204,
      edge: null,
      degraded: null,
    });
  });

  it('logs a 5xx at error level, with how it was served', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ctx, pending } = executionContext();

    await withRequestLog(
      new Request('http://local/contracts'),
      { LOG_IP_KEY: LOG_KEY } as Env,
      ctx,
      async () => new Response('busy', { status: 503, headers: { 'X-Edge-Cache': 'BYPASS' } }),
    );
    await Promise.all(pending);

    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(error.mock.calls[0]?.[0] as string)).toMatchObject({
      level: 'error',
      path: '/contracts',
      status: 503,
      edge: 'BYPASS',
      degraded: null,
    });
  });

  it('logs a page served without one of its parts at warn level', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx, pending } = executionContext();

    await withRequestLog(
      new Request('http://local/accessibility'),
      { LOG_IP_KEY: LOG_KEY } as Env,
      ctx,
      async () =>
        new Response('page', { headers: { 'X-Edge-Cache': 'HIT', 'X-Sigma-Degraded': 'footer' } }),
    );
    await Promise.all(pending);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0]?.[0] as string)).toMatchObject({
      level: 'warn',
      status: 200,
      edge: 'HIT',
      degraded: 'footer',
    });
  });

  it('queues one 500 log when the handler throws and then rethrows', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ctx, pending, waitUntil } = executionContext();
    const error = new Error('handler failed');

    await expect(
      withRequestLog(
        new Request('http://local/fail'),
        { LOG_IP_KEY: LOG_KEY } as Env,
        ctx,
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);
    await Promise.all(pending);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({
      level: 'error',
      status: 500,
      edge: null,
    });
  });
});
