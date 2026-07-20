import { describe, expect, it, vi } from 'vitest';
import { EOP_EARLIEST_DAY, fetchEopDay, validateEopDate, type FetchImpl } from './eop-fetch';

describe('validateEopDate', () => {
  const today = '2026-06-19';
  it('accepts a well-formed day within the covered range', () => {
    expect(validateEopDate('2023-05-01', today)).toEqual({ ok: true, day: '2023-05-01' });
  });
  it('rejects a malformed date', () => {
    expect(validateEopDate('2023/05/01', today).ok).toBe(false);
    expect(validateEopDate('hier; DROP', today).ok).toBe(false);
  });
  it('rejects a structurally-valid but non-existent calendar date (review #80)', () => {
    // matches DAY_RE but is not a real day — would otherwise build a URL that just 404s
    expect(validateEopDate('2023-13-45', today).ok).toBe(false);
    expect(validateEopDate('2023-02-30', today).ok).toBe(false);
    expect(validateEopDate('2023-00-10', today).ok).toBe(false);
  });
  it('rejects trailing input after a valid date prefix (no slice smuggling, review #80)', () => {
    expect(validateEopDate('2023-05-01; DROP TABLE', today).ok).toBe(false);
    expect(validateEopDate('2023-05-01T00:00:00', today).ok).toBe(false);
  });
  it('rejects dates before coverage and in the future', () => {
    expect(validateEopDate('2019-12-31', today).ok).toBe(false);
    expect(validateEopDate('2027-01-01', today).ok).toBe(false);
    expect(validateEopDate(EOP_EARLIEST_DAY, today).ok).toBe(true);
  });
});

describe('fetchEopDay', () => {
  it('parses each day file into untrusted rows (base/URLs are server-fixed, never the model)', async () => {
    const fetchImpl: FetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '[{"uniqueProcurementNumber":"00044-2023-0018"}]',
    }));
    const files = await fetchEopDay('2023-05-01', fetchImpl);
    expect(files.length).toBe(3); // три базови файла за ден преди 2026
    expect(files[0]!.rows).toEqual([{ uniqueProcurementNumber: '00044-2023-0018' }]);
    // every fetched URL points at the fixed open-data host, not anything model-controlled
    for (const call of (fetchImpl as ReturnType<typeof vi.fn>).mock.calls) {
      expect(String(call[0])).toMatch(/^https:\/\/storage\.eop\.bg\/open-data-2023-05-01\//);
    }
  });

  it('surfaces a missing day (403) as a per-file error, not a throw', async () => {
    const fetchImpl: FetchImpl = async () => ({ ok: false, status: 403, text: async () => '' });
    const files = await fetchEopDay('2023-05-01', fetchImpl);
    // A failed fetch must surface an error AND no rows — not an empty-but-"successful" result.
    expect(files.every((f) => f.error === 'HTTP 403' && f.rows === undefined)).toBe(true);
  });

  it('withholds an oversized response instead of parsing it to the model', async () => {
    const huge = JSON.stringify(Array.from({ length: 5000 }, (_, i) => ({ i })));
    const fetchImpl: FetchImpl = async () => ({ ok: true, status: 200, text: async () => huge });
    const files = await fetchEopDay('2023-05-01', fetchImpl, 256);
    // The cap must WITHHOLD the rows, not merely flag truncation — the old code parsed the full body
    // (valid JSON) and returned every row despite the cap.
    expect(files.every((f) => f.truncated && f.rows === undefined && !!f.error)).toBe(true);
  });

  it('withholds an over-cap response by Content-Length WITHOUT reading the body (review #80)', async () => {
    let read = false;
    const fetchImpl: FetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (n) => (n.toLowerCase() === 'content-length' ? String(10 * 1024 * 1024) : null),
      },
      text: async () => {
        read = true;
        return '[]';
      },
    });
    const files = await fetchEopDay('2023-05-01', fetchImpl, 256 * 1024);
    expect(files.every((f) => f.truncated && f.rows === undefined && !!f.error)).toBe(true);
    expect(read).toBe(false); // body was never buffered into Worker memory
  });
});
