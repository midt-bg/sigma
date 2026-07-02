import { withDataSource } from './dataSource';

const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
const CSV_CACHE_CONTROL = 'public, max-age=3600';
const CSV_MULTIPART_PART_SIZE = 8 * 1024 * 1024;

const ARRAY_FILTERS = ['years', 'sectors', 'procedureGroups', 'kinds', 'types'] as const;
// `bids` ('one' | null) is a response-affecting filter: without it here a „само една оферта" export
// was misclassified as unfiltered and served from / written to the shared unfiltered cache object —
// a cache-poisoning variant of #56/#122 on top of the wrong-data bug (#138). hasScalarFilter treats
// 'one' as set and null as absent, so it slots in cleanly. Other routes simply never carry the key.
const SCALAR_FILTERS = ['valueBucket', 'eu', 'authority', 'bidder', 'countBucket', 'bids'] as const;
const FILENAMES = {
  contracts: 'sigma-contracts.csv',
  companies: 'sigma-companies.csv',
  authorities: 'sigma-authorities.csv',
} as const;

type CsvExportRoute = keyof typeof FILENAMES;
type CsvCacheState = 'dynamic' | 'HIT' | 'MISS';
type ParamBag = Record<string, unknown>;

interface CsvExportEnv {
  DB: D1Database;
  CSV_CACHE: R2Bucket;
}

interface ServedCsvExportOptions {
  env: CsvExportEnv;
  request: Request;
  route: CsvExportRoute;
  params: object;
  stream: () => Response;
}

function param(params: object, key: string): unknown {
  return key in params ? (params as ParamBag)[key] : undefined;
}

function hasArrayFilter(params: object, key: (typeof ARRAY_FILTERS)[number]): boolean {
  const value = param(params, key);
  return Array.isArray(value) && value.length > 0;
}

function hasScalarFilter(params: object, key: (typeof SCALAR_FILTERS)[number]): boolean {
  const value = param(params, key);
  return value !== null && value !== undefined && value !== '';
}

function hasSearchFilter(params: object): boolean {
  const value = param(params, 'q');
  return typeof value === 'string' ? value.trim() !== '' : value !== null && value !== undefined;
}

function markCsvCache(response: Response, cache: CsvCacheState): Response {
  const withSource = withDataSource(response);
  withSource.headers.set('X-Csv-Cache', cache);
  return withSource;
}

function hasBody(obj: R2Object | R2ObjectBody): obj is R2ObjectBody {
  return 'body' in obj && obj.body != null;
}

function rangeInfo(obj: R2ObjectBody): { start: number; end: number; length: number } | null {
  const range = obj.range;
  if (!range) return null;

  if ('offset' in range && range.offset !== undefined) {
    const start = range.offset;
    const length =
      'length' in range && range.length !== undefined ? range.length : obj.size - start;
    return { start, end: start + length - 1, length };
  }

  if ('suffix' in range) {
    const length = Math.min(range.suffix, obj.size);
    const start = obj.size - length;
    return { start, end: obj.size - 1, length };
  }

  if ('length' in range && range.length !== undefined) {
    const length = range.length;
    return { start: 0, end: length - 1, length };
  }

  return null;
}

function responseFromR2Object(
  obj: R2Object | R2ObjectBody,
  route: CsvExportRoute,
  cache: CsvCacheState,
) {
  if (!hasBody(obj)) {
    return markCsvCache(
      new Response(null, { status: 304, headers: { ETag: obj.httpEtag } }),
      cache,
    );
  }

  const range = rangeInfo(obj);
  const headers = new Headers({
    'Content-Type': CSV_CONTENT_TYPE,
    'Content-Disposition': `attachment; filename="${FILENAMES[route]}"`,
    ETag: obj.httpEtag,
    'Accept-Ranges': 'bytes',
    'Cache-Control': CSV_CACHE_CONTROL,
    'Content-Length': String(range?.length ?? obj.size),
  });
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${obj.size}`);

  return markCsvCache(new Response(obj.body, { status: range ? 206 : 200, headers }), cache);
}

async function putStreamMultipart(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  contentType: string,
): Promise<void> {
  const upload = await bucket.createMultipartUpload(key, {
    httpMetadata: { contentType },
  });
  const reader = body.getReader();
  const parts: R2UploadedPart[] = [];
  let partNumber = 1;
  let buffer = new Uint8Array(CSV_MULTIPART_PART_SIZE);
  let buffered = 0;

  async function uploadBufferedPart(): Promise<void> {
    if (buffered === 0) return;
    const chunk = buffered === buffer.byteLength ? buffer : buffer.subarray(0, buffered);
    parts.push(await upload.uploadPart(partNumber, chunk));
    partNumber += 1;
    buffer = new Uint8Array(CSV_MULTIPART_PART_SIZE);
    buffered = 0;
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;

      let offset = 0;
      while (offset < value.byteLength) {
        const available = buffer.byteLength - buffered;
        const take = Math.min(available, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + take), buffered);
        buffered += take;
        offset += take;

        if (buffered === buffer.byteLength) await uploadBufferedPart();
      }
    }

    await uploadBufferedPart();
    await upload.complete(parts);
  } catch (error) {
    try {
      await upload.abort();
    } catch {
      // Best-effort cleanup; preserve the original upload failure.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function isUnfilteredCsvExport(params: object): boolean {
  for (const key of ARRAY_FILTERS) {
    if (key in params && hasArrayFilter(params, key)) return false;
  }

  for (const key of SCALAR_FILTERS) {
    if (key in params && hasScalarFilter(params, key)) return false;
  }

  if ('q' in params && hasSearchFilter(params)) return false;

  return true;
}

export async function freshnessVersion(db: D1Database): Promise<string> {
  const row = await db
    .prepare('SELECT refreshed_at FROM home_totals WHERE id = 1')
    .first<{ refreshed_at: string | null }>();
  const version = row?.refreshed_at?.replace(/[^a-z0-9]/gi, '') ?? '';
  return version || 'v0';
}

export async function servedCsvExport({
  env,
  request,
  route,
  params,
  stream,
}: ServedCsvExportOptions): Promise<Response> {
  if (!isUnfilteredCsvExport(params)) {
    return markCsvCache(stream(), 'dynamic');
  }

  const version = await freshnessVersion(env.DB);
  // The CSV streamers order strictly by the keyset id column and ignore `sort`, so the unfiltered
  // export bytes are identical regardless of the URL's `sort`. Keying on `sort` would mint a distinct
  // R2 object per arbitrary value (storage/scan amplification) for no benefit, so it is excluded.
  const key = `csv/${route}/${version}`;
  // Only pass `range` when the client actually sent a Range header — otherwise R2 (miniflare)
  // returns the full object with `obj.range` set, which would make a plain GET a 206 instead of 200.
  const getOpts: R2GetOptions = request.headers.has('Range')
    ? { onlyIf: request.headers, range: request.headers }
    : { onlyIf: request.headers };
  let obj = await env.CSV_CACHE.get(key, getOpts);
  if (obj === null) {
    await putStreamMultipart(env.CSV_CACHE, key, stream().body!, CSV_CONTENT_TYPE);
    obj = await env.CSV_CACHE.get(key, getOpts);
    if (obj === null) throw new Error(`CSV cache object missing after put: ${key}`);
    return responseFromR2Object(obj, route, 'MISS');
  }

  return responseFromR2Object(obj, route, 'HIT');
}
