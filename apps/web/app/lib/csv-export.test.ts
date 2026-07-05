import { describe, expect, it, vi } from 'vitest';
import { AUTHORITY_FILTER_KEYS, COMPANY_FILTER_KEYS, CONTRACT_FILTER_KEYS } from '@sigma/db';
import { DATA_SOURCE } from './dataSource';
import { isUnfilteredCsvExport, servedCsvExport } from './csv-export';

const REFRESHED_AT = '2026-06-13T10:00:00Z';
const VERSION = '20260613T100000Z';
const CSV_BODY = '0123456789abcdef\n';
const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
const MULTIPART_PART_SIZE = 8 * 1024 * 1024;

type R2PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob;
type R2MultipartPartValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob;
type ServedCsvEnv = Parameters<typeof servedCsvExport>[0]['env'];

interface StoredObject {
  bytes: Uint8Array;
  etag: string;
  contentType?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });
}

async function bytesFromValue(value: R2PutValue): Promise<Uint8Array> {
  if (value === null) return new Uint8Array();
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof ReadableStream) {
    return new Uint8Array(await new Response(value).arrayBuffer());
  }
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new Uint8Array(view);
  }
  return new Uint8Array();
}

function arrayBufferFrom(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function contentTypeFrom(metadata: R2PutOptions['httpMetadata'] | undefined): string | undefined {
  return metadata instanceof Headers
    ? (metadata.get('Content-Type') ?? undefined)
    : metadata?.contentType;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function fakeDb(refreshedAt: string | null | undefined = REFRESHED_AT): D1Database {
  return {
    prepare: vi.fn((sql: string) => ({
      first: vi.fn(async () => {
        expect(sql).toBe('SELECT refreshed_at FROM home_totals WHERE id = 1');
        return refreshedAt === undefined ? null : { refreshed_at: refreshedAt };
      }),
    })),
  } as unknown as D1Database;
}

class InMemoryR2 {
  private objects = new Map<string, StoredObject>();
  private uploadPartCallCounts: number[] = [];
  private nextEtag = 1;

  get = vi.fn(async (key: string, options?: R2GetOptions) => {
    const stored = this.objects.get(key);
    if (!stored) return null;

    const onlyIf = options?.onlyIf;
    if (onlyIf instanceof Headers && onlyIf.get('if-none-match') === stored.etag) {
      return this.objectWithoutBody(key, stored);
    }

    const range = this.rangeFrom(options?.range, stored.bytes.length);
    const bytes = range
      ? stored.bytes.slice(range.offset, range.offset + range.length)
      : stored.bytes.slice();
    return this.objectWithBody(key, stored, bytes, range);
  });

  put = vi.fn(async (key: string, value: R2PutValue, options?: R2PutOptions) => {
    if (value instanceof ReadableStream) {
      throw new TypeError(
        'Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)',
      );
    }
    const bytes = await bytesFromValue(value);
    const etag = `"etag-${this.nextEtag++}"`;
    this.objects.set(key, {
      bytes,
      etag,
      contentType: contentTypeFrom(options?.httpMetadata),
    });
    return this.objectWithoutBody(key, this.objects.get(key)!);
  });

  createMultipartUpload = vi.fn(async (key: string, options?: R2MultipartOptions) => {
    const recorded = new Map<number, Uint8Array>();
    const uploadIndex = this.uploadPartCallCounts.push(0) - 1;
    const uploadId = `upload-${uploadIndex + 1}`;

    return {
      key,
      uploadId,
      uploadPart: async (partNumber: number, value: R2MultipartPartValue) => {
        this.uploadPartCallCounts[uploadIndex] += 1;
        recorded.set(partNumber, await bytesFromValue(value));
        return { partNumber, etag: `"part-${uploadId}-${partNumber}"` };
      },
      complete: async (parts: R2UploadedPart[]) => {
        const ordered = [...parts]
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((part) => recorded.get(part.partNumber) ?? new Uint8Array());
        const etag = `"etag-${this.nextEtag++}"`;
        this.objects.set(key, {
          bytes: concatBytes(ordered),
          etag,
          contentType: contentTypeFrom(options?.httpMetadata),
        });
        return this.objectWithoutBody(key, this.objects.get(key)!);
      },
      abort: async () => {
        recorded.clear();
      },
    } as R2MultipartUpload;
  });

  keyCount(): number {
    return this.objects.size;
  }

  uploadPartCallCount(): number {
    return this.uploadPartCallCounts.reduce((sum, count) => sum + count, 0);
  }

  lastUploadPartCallCount(): number {
    return this.uploadPartCallCounts.at(-1) ?? 0;
  }

  private objectWithoutBody(key: string, stored: StoredObject): R2Object {
    return {
      key,
      version: '1',
      size: stored.bytes.length,
      etag: stored.etag.replaceAll('"', ''),
      httpEtag: stored.etag,
      checksums: {},
      uploaded: new Date('2026-06-13T10:00:00Z'),
      httpMetadata: stored.contentType ? { contentType: stored.contentType } : undefined,
      storageClass: 'Standard',
      writeHttpMetadata(headers: Headers) {
        if (stored.contentType) headers.set('Content-Type', stored.contentType);
      },
    } as unknown as R2Object;
  }

  private objectWithBody(
    key: string,
    stored: StoredObject,
    bytes: Uint8Array,
    range?: { offset: number; length: number },
  ): R2ObjectBody {
    return {
      ...this.objectWithoutBody(key, stored),
      ...(range ? { range } : {}),
      body: streamFromBytes(bytes),
      bodyUsed: false,
      arrayBuffer: async () => arrayBufferFrom(bytes),
      bytes: async () => bytes.slice(),
      text: async () => decoder.decode(bytes),
      json: async <T>() => JSON.parse(decoder.decode(bytes)) as T,
      blob: async () => new Blob([arrayBufferFrom(bytes)], { type: stored.contentType }),
    } as unknown as R2ObjectBody;
  }

  private rangeFrom(
    range: R2GetOptions['range'] | undefined,
    size: number,
  ): { offset: number; length: number } | undefined {
    if (range === undefined) return undefined;

    if (range instanceof Headers) {
      const header = range.get('range');
      if (header === null) return { offset: 0, length: size };

      const match = /^bytes=(\d+)-(\d+)$/.exec(header);
      if (!match) return undefined;

      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), size - 1);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        return undefined;
      }
      return { offset: start, length: end - start + 1 };
    }

    if ('suffix' in range) {
      const length = Math.min(range.suffix, size);
      return { offset: size - length, length };
    }

    const offset = range.offset ?? 0;
    const length = Math.min(range.length ?? size - offset, size - offset);
    return { offset, length };
  }
}

function envWith(
  r2: InMemoryR2,
  refreshedAt: string | null | undefined = REFRESHED_AT,
): ServedCsvEnv {
  return { DB: fakeDb(refreshedAt), CSV_CACHE: r2 as unknown as R2Bucket };
}

function csvResponse(body = CSV_BODY): Response {
  return new Response(body, {
    headers: {
      'Content-Type': CSV_CONTENT_TYPE,
      'Content-Disposition': 'attachment; filename="sigma-contracts.csv"',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

function csvBytesResponse(body: Uint8Array): Response {
  return new Response(streamFromBytes(body), {
    headers: {
      'Content-Type': CSV_CONTENT_TYPE,
      'Content-Disposition': 'attachment; filename="sigma-contracts.csv"',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

function serve(
  r2: InMemoryR2,
  stream: () => Response,
  opts: {
    request?: Request;
    params?: object;
    sort?: string;
    refreshedAt?: string | null | undefined;
  } = {},
): Promise<Response> {
  return servedCsvExport({
    env: envWith(r2, opts.refreshedAt),
    request: opts.request ?? new Request('http://local/contracts.csv'),
    route: 'contracts',
    params: opts.params ?? { sort: opts.sort ?? 'value-desc' },
    stream,
  });
}

describe('isUnfilteredCsvExport', () => {
  it('treats empty and fictive filters as unfiltered', () => {
    expect(isUnfilteredCsvExport({})).toBe(true);
    expect(
      isUnfilteredCsvExport({
        sort: 'value-desc',
        years: [],
        sectors: [],
        procedureGroups: [],
        kinds: [],
        types: [],
        valueBucket: null,
        eu: undefined,
        authority: '',
        bidder: '',
        countBucket: '',
        q: '   ',
      }),
    ).toBe(true);
  });

  it('ignores sort-only params', () => {
    expect(isUnfilteredCsvExport({ sort: 'date-asc' })).toBe(true);
  });

  it.each([
    ['years', { years: ['2025'] }],
    ['sectors', { sectors: ['45'] }],
    ['procedureGroups', { procedureGroups: ['open'] }],
    ['valueBucket', { valueBucket: 'gt100m' }],
    ['eu', { eu: 'eu' }],
    ['authority', { authority: '123456789' }],
    ['bidder', { bidder: 'acme' }],
    ['q', { q: 'rail' }],
    ['bids', { bids: 'one' }],
    ['companies.kinds', { kinds: ['company'] }],
    ['companies.countBucket', { countBucket: '2-5' }],
    ['authorities.types', { types: ['municipality'] }],
  ])('treats %s as narrowing', (_name, params) => {
    expect(isUnfilteredCsvExport({ sort: 'value-desc', ...params })).toBe(false);
  });

  // Completeness guard (issue #138): every filter ANY list query consumes must also be seen by the
  // cache classifier, or a filtered export gets served from / written to the unfiltered cache object.
  // Iterating all three *_FILTER_KEYS means adding a key to any of them without teaching
  // isUnfilteredCsvExport about it fails CI — closing the whole bug class across contracts/authorities/
  // companies, not just `bids`.
  const ALL_FILTER_KEYS = [
    ...CONTRACT_FILTER_KEYS,
    ...AUTHORITY_FILTER_KEYS,
    ...COMPANY_FILTER_KEYS,
  ] as const;
  // A representative "active" value per filter key (arrays non-empty, scalars truthy non-empty).
  const ACTIVE: Record<(typeof ALL_FILTER_KEYS)[number], unknown> = {
    years: ['2025'],
    sectors: ['45'],
    procedureGroups: ['open'],
    valueBucket: 'gt100m',
    eu: 'eu',
    authority: '123456789',
    bidder: 'acme',
    q: 'rail',
    bids: 'one',
    types: ['municipality'],
    kinds: ['company'],
    countBucket: '2-5',
  };
  it.each([...new Set(ALL_FILTER_KEYS)])('classifier recognises the %s list filter', (key) => {
    expect(ACTIVE[key]).toBeDefined(); // a new filter key without a representative value here is a bug
    expect(isUnfilteredCsvExport({ sort: 'value-desc', [key]: ACTIVE[key] })).toBe(false);
  });
});

describe('servedCsvExport', () => {
  it('generates and stores an unfiltered CSV on first request', async () => {
    const r2 = new InMemoryR2();
    const stream = vi.fn(() => csvResponse());

    const response = await serve(r2, stream);

    expect(response.status).toBe(200);
    expect(response.status).not.toBe(206);
    expect(response.headers.get('X-Csv-Cache')).toBe('MISS');
    expect(response.headers.get('X-Data-Source')).toBe(DATA_SOURCE);
    expect(response.headers.get('Content-Type')).toBe(CSV_CONTENT_TYPE);
    expect(response.headers.get('Content-Range')).toBeNull();
    expect(await response.text()).toBe(CSV_BODY);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(r2.put).not.toHaveBeenCalled();
    expect(r2.createMultipartUpload).toHaveBeenCalledTimes(1);
    expect(r2.createMultipartUpload).toHaveBeenCalledWith(`csv/contracts/${VERSION}`, {
      httpMetadata: { contentType: CSV_CONTENT_TYPE },
    });
    expect(r2.lastUploadPartCallCount()).toBe(1);
    expect(r2.get).toHaveBeenLastCalledWith(`csv/contracts/${VERSION}`, {
      onlyIf: expect.any(Headers),
    });
  });

  it('serves a repeat unfiltered request from R2 without calling the stream function', async () => {
    const r2 = new InMemoryR2();
    const missStream = vi.fn(() => csvResponse());
    await (await serve(r2, missStream)).text();
    r2.createMultipartUpload.mockClear();

    const hitStream = vi.fn(() => csvResponse('from db\n'));
    const response = await serve(r2, hitStream);

    expect(response.status).toBe(200);
    expect(response.status).not.toBe(206);
    expect(response.headers.get('Content-Range')).toBeNull();
    expect(response.headers.get('X-Csv-Cache')).toBe('HIT');
    expect(await response.text()).toBe(CSV_BODY);
    expect(hitStream).not.toHaveBeenCalled();
    expect(r2.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('does not vary the cache key by sort: a different sort hits the same object', async () => {
    const r2 = new InMemoryR2();
    const missStream = vi.fn(() => csvResponse());
    await (await serve(r2, missStream, { params: { sort: 'value-desc' } })).text();
    r2.createMultipartUpload.mockClear();

    const hitStream = vi.fn(() => csvResponse('from db\n'));
    const response = await serve(r2, hitStream, { params: { sort: 'date-asc' } });

    expect(response.headers.get('X-Csv-Cache')).toBe('HIT');
    expect(await response.text()).toBe(CSV_BODY);
    expect(hitStream).not.toHaveBeenCalled();
    expect(r2.createMultipartUpload).not.toHaveBeenCalled();
    expect(r2.keyCount()).toBe(1);
  });

  it('returns 304 for a matching If-None-Match on an unfiltered request', async () => {
    const r2 = new InMemoryR2();
    const stream = vi.fn(() => csvResponse());
    const primed = await serve(r2, stream);
    const etag = primed.headers.get('ETag');
    await primed.text();

    const response = await serve(
      r2,
      vi.fn(() => csvResponse('from db\n')),
      {
        request: new Request('http://local/contracts.csv', {
          headers: { 'If-None-Match': etag ?? '' },
        }),
      },
    );

    expect(response.status).toBe(304);
    expect(response.headers.get('ETag')).toBe(etag);
    expect(response.headers.get('X-Csv-Cache')).toBe('HIT');
    expect(response.headers.get('X-Data-Source')).toBe(DATA_SOURCE);
    expect(await response.text()).toBe('');
  });

  it('serves byte ranges from R2', async () => {
    const r2 = new InMemoryR2();
    await (
      await serve(
        r2,
        vi.fn(() => csvResponse()),
      )
    ).text();

    const response = await serve(
      r2,
      vi.fn(() => csvResponse('from db\n')),
      {
        request: new Request('http://local/contracts.csv', {
          headers: { Range: 'bytes=0-9' },
        }),
      },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe(
      `bytes 0-9/${encoder.encode(CSV_BODY).length}`,
    );
    expect(response.headers.get('Content-Length')).toBe('10');
    expect(response.headers.get('X-Csv-Cache')).toBe('HIT');
    expect(await response.text()).toBe('0123456789');
  });

  it('keeps filtered requests dynamic without touching R2', async () => {
    const r2 = new InMemoryR2();
    const stream = vi.fn(() => csvResponse('filtered\n'));

    const response = await serve(r2, stream, { params: { sort: 'value-desc', q: 'foo' } });

    expect(response.headers.get('X-Csv-Cache')).toBe('dynamic');
    expect(response.headers.get('X-Data-Source')).toBe(DATA_SOURCE);
    expect(await response.text()).toBe('filtered\n');
    expect(stream).toHaveBeenCalledTimes(1);
    expect(r2.get).not.toHaveBeenCalled();
    expect(r2.put).not.toHaveBeenCalled();
    expect(r2.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('uses freshnessVersion in the key and regenerates after a refresh changes', async () => {
    const r2 = new InMemoryR2();
    const stream = vi
      .fn<() => Response>()
      .mockImplementationOnce(() => csvResponse('first\n'))
      .mockImplementationOnce(() => csvResponse('second\n'));

    await (await serve(r2, stream, { refreshedAt: '2026-06-13T10:00:00Z' })).text();
    const response = await serve(r2, stream, { refreshedAt: '2026-06-14T10:00:00Z' });

    expect(response.headers.get('X-Csv-Cache')).toBe('MISS');
    expect(await response.text()).toBe('second\n');
    expect(stream).toHaveBeenCalledTimes(2);
    expect(r2.createMultipartUpload).toHaveBeenCalledTimes(2);
    expect(r2.put).not.toHaveBeenCalled();
    expect(r2.keyCount()).toBe(2);
  });

  it('uploads bodies larger than the multipart threshold as multiple parts', async () => {
    const r2 = new InMemoryR2();
    const largeBody = new Uint8Array(MULTIPART_PART_SIZE + 1024 * 1024);
    largeBody.fill(65);
    const stream = vi.fn(() => csvBytesResponse(largeBody));

    const response = await serve(r2, stream);

    expect(response.headers.get('X-Csv-Cache')).toBe('MISS');
    expect(r2.createMultipartUpload).toHaveBeenCalledTimes(1);
    expect(r2.lastUploadPartCallCount()).toBeGreaterThanOrEqual(2);
    expect((await response.arrayBuffer()).byteLength).toBe(largeBody.byteLength);
  });
});
