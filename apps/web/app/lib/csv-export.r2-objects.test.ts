// What the unfiltered CSV export makes of the object R2 hands back: a range given only as a length starts at
// byte 0, a range R2 reports but that places nothing is served as the whole object, and an object still missing
// after a completed upload is an error — never an empty 200 that the edge would cache as the export.
import { describe, expect, it, vi } from 'vitest';
import { fakeD1 } from '@sigma/test-support';
import { servedCsvExport } from './csv-export';

const CSV = '0123456789abcdef\n';
const OBJECT_PATH = 'csv/contracts/20260613T100000Z';
const encoder = new TextEncoder();

const db = () =>
  fakeD1([
    {
      when: 'SELECT refreshed_at FROM home_totals WHERE id = 1',
      first: { refreshed_at: '2026-06-13T10:00:00Z' },
    },
  ]).db;

const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

/** A bucket whose object carries the given `range`, as R2 reports it, and the bytes R2 would send. */
function bucketWith(range: unknown, text: string) {
  return {
    get: vi.fn(async () => ({
      key: OBJECT_PATH,
      size: encoder.encode(CSV).length,
      httpEtag: '"etag-1"',
      range,
      body: stream(text),
    })),
    createMultipartUpload: vi.fn(),
  };
}

const serve = (bucket: object, headers: HeadersInit = {}) =>
  servedCsvExport({
    env: { DB: db(), CSV_CACHE: bucket as unknown as R2Bucket },
    request: new Request('http://local/contracts.csv', { headers }),
    route: 'contracts',
    params: { sort: 'value-desc' },
    stream: () => new Response(CSV, { headers: { 'Content-Type': 'text/csv; charset=utf-8' } }),
  });

describe('servedCsvExport — the object R2 returns', () => {
  it('serves a range given only as a length from the first byte', async () => {
    const bucket = bucketWith({ length: 5 }, CSV.slice(0, 5));
    const res = await serve(bucket, { Range: 'bytes=0-4' });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 0-4/${CSV.length}`);
    expect(res.headers.get('Content-Length')).toBe('5');
    expect(res.headers.get('X-Csv-Cache')).toBe('HIT');
    expect(await res.text()).toBe('01234');
    expect(bucket.get).toHaveBeenCalledWith(OBJECT_PATH, {
      onlyIf: expect.any(Headers),
      range: expect.any(Headers),
    });
  });

  it('serves the whole object when the reported range places no bytes', async () => {
    for (const range of [{}, { offset: undefined, length: undefined }]) {
      const res = await serve(bucketWith(range, CSV));
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Range')).toBeNull();
      expect(res.headers.get('Content-Length')).toBe(String(CSV.length));
      expect(await res.text()).toBe(CSV);
    }
  });

  it('fails when the object is still missing after a completed upload', async () => {
    const upload = {
      uploadPart: vi.fn(async (partNumber: number) => ({
        partNumber,
        etag: `"part-${partNumber}"`,
      })),
      complete: vi.fn(async () => ({})),
      abort: vi.fn(async () => {}),
    };
    const bucket = {
      get: vi.fn(async () => null),
      createMultipartUpload: vi.fn(async () => upload),
    };
    await expect(serve(bucket)).rejects.toThrow(
      `CSV cache object missing after put: ${OBJECT_PATH}`,
    );
    expect(upload.complete).toHaveBeenCalledTimes(1);
    expect(upload.abort).not.toHaveBeenCalled();
    expect(bucket.get).toHaveBeenCalledTimes(2); // the miss, then the read-back after the upload
  });

  // Real R2 fills `range` on a full read as well, so deciding the status by the object answered a plain
  // GET with 206 and a Content-Range spanning the whole file. The status has to follow the REQUEST.
  it('answers a plain GET with 200, even when the object reports a full-length range', async () => {
    const bucket = bucketWith({ offset: 0, length: CSV.length }, CSV);
    const res = await serve(bucket);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Range')).toBeNull();
    expect(res.headers.get('Content-Length')).toBe(String(CSV.length));
    expect(await res.text()).toBe(CSV);
  });
});
