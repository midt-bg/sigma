import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDigestTrigger, type DigestTriggerEnv } from './digest-trigger';

// The trigger's job is gating + dispatch, not generation — stub only generateWeeklyDigest, keeping the
// real digestEnabled (the trigger reuses it) and everything else the module exports.
vi.mock('./weekly-digest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./weekly-digest')>()),
  generateWeeklyDigest: vi.fn(async () => {}),
}));
const { generateWeeklyDigest } = await import('./weekly-digest');
const mockedGenerate = vi.mocked(generateWeeklyDigest);

const TOKEN = 'super-secret-trigger-token';

function env(overrides: Partial<DigestTriggerEnv> = {}): DigestTriggerEnv {
  return {
    DB: {} as D1Database,
    REPORTS: {} as R2Bucket,
    DIGEST_TRIGGER_ENABLED: 'true',
    DIGEST_TRIGGER_TOKEN: TOKEN,
    ...overrides,
  };
}

function req(opts: { method?: string; token?: string | null; week?: string } = {}): Request {
  const url = new URL('https://etl.internal/');
  if (opts.week) url.searchParams.set('week', opts.week);
  const headers = new Headers();
  if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);
  return new Request(url, { method: opts.method ?? 'POST', headers });
}

beforeEach(() => mockedGenerate.mockClear());

describe('handleDigestTrigger', () => {
  it('404s when the enable flag is off', async () => {
    const r = await handleDigestTrigger(
      req({ token: TOKEN }),
      env({ DIGEST_TRIGGER_ENABLED: 'false' }),
    );
    expect(r.status).toBe(404);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('404s when enabled but no token is configured (cannot be driven)', async () => {
    const r = await handleDigestTrigger(
      req({ token: TOKEN }),
      env({ DIGEST_TRIGGER_TOKEN: undefined }),
    );
    expect(r.status).toBe(404);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('405s on a non-POST method', async () => {
    const r = await handleDigestTrigger(req({ method: 'GET', token: TOKEN }), env());
    expect(r.status).toBe(405);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('401s with no bearer token', async () => {
    const r = await handleDigestTrigger(req({ token: null }), env());
    expect(r.status).toBe(401);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('401s with a wrong token', async () => {
    const r = await handleDigestTrigger(req({ token: 'not-the-token' }), env());
    expect(r.status).toBe(401);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('400s on a malformed week', async () => {
    const r = await handleDigestTrigger(req({ token: TOKEN, week: '2026W28' }), env());
    expect(r.status).toBe(400);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('400s on a format-valid but out-of-range week (never reaches generation)', async () => {
    const r = await handleDigestTrigger(req({ token: TOKEN, week: '2026-W99' }), env());
    expect(r.status).toBe(400);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('200s and dispatches for the prior week when authorized with no week param', async () => {
    const r = await handleDigestTrigger(req({ token: TOKEN }), env());
    expect(r.status).toBe(200);
    await expect(r.json()).resolves.toEqual({ ok: true, week: 'prior' });
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(mockedGenerate.mock.calls[0]![1]).toEqual({});
  });

  it('200s and passes targetIso for a valid week', async () => {
    const r = await handleDigestTrigger(req({ token: TOKEN, week: '2026-W28' }), env());
    expect(r.status).toBe(200);
    await expect(r.json()).resolves.toEqual({ ok: true, week: '2026-W28' });
    expect(mockedGenerate).toHaveBeenCalledWith(expect.anything(), { targetIso: '2026-W28' });
  });

  it('500s when generation throws (and does not leak a stack, just the message)', async () => {
    mockedGenerate.mockRejectedValueOnce(new Error('boom'));
    const r = await handleDigestTrigger(req({ token: TOKEN }), env());
    expect(r.status).toBe(500);
    await expect(r.json()).resolves.toMatchObject({ error: 'generate_failed', message: 'boom' });
  });
});
