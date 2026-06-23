import { describe, expect, it, vi } from 'vitest';
import { buildHealthResponse, pingDb } from './health';

function mockDb(firstResult: unknown, shouldThrow = false): D1Database {
  const first = vi.fn().mockImplementation(async () => {
    if (shouldThrow) throw new Error('D1 unavailable');
    return firstResult;
  });
  const prepare = vi.fn().mockReturnValue({ first });
  return { prepare } as unknown as D1Database;
}

describe('pingDb', () => {
  it('returns ok when SELECT 1 succeeds', async () => {
    expect(await pingDb(mockDb({ ok: 1 }))).toBe('ok');
  });

  it('returns error when D1 throws', async () => {
    expect(await pingDb(mockDb(null, true))).toBe('error');
  });
});

describe('buildHealthResponse', () => {
  it('returns 200 JSON when db is ok', async () => {
    const response = buildHealthResponse('ok', new Date('2026-06-23T12:00:00.000Z'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ts: '2026-06-23T12:00:00.000Z',
      db: 'ok',
    });
  });

  it('returns 503 JSON when db is error', async () => {
    const response = buildHealthResponse('error', new Date('2026-06-23T12:00:00.000Z'));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      ts: '2026-06-23T12:00:00.000Z',
      db: 'error',
    });
  });
});
