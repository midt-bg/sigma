import { describe, expect, it, vi } from 'vitest';
import { withDbRetry } from './retry';

describe('withDbRetry', () => {
  it('returns the result without retrying when the fetch succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    await expect(withDbRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient error and resolves once it succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('D1_ERROR: Network connection lost'))
      .mockResolvedValue('recovered');

    await expect(withDbRetry(fn)).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up and throws the last error after exhausting attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('still down'));

    await expect(withDbRetry(fn, 3)).rejects.toThrow('still down');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('never retries a thrown Response (404/redirect control flow)', async () => {
    const notFound = new Response('Not Found', { status: 404 });
    const fn = vi.fn().mockRejectedValue(notFound);

    await expect(withDbRetry(fn)).rejects.toBe(notFound);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs once and surfaces the real error when attempts <= 0 (never throws undefined)', async () => {
    const err = new Error('down');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withDbRetry(fn, 0)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
