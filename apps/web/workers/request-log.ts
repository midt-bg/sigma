export interface RequestLogEnv {
  LOG_IP_KEY?: string;
}

/**
 * `error` for a 5xx, `warn` for a page served without one of its parts (X-Sigma-Degraded), `info`
 * otherwise. The entry is written through the console method of the same name, so the Workers Logs
 * level matches and a sustained run of 5xx can be filtered and alerted on by level alone.
 */
export type RequestLogLevel = 'info' | 'warn' | 'error';

/** What the response says about how it was served; absent when the handler threw. */
export interface ServedBy {
  /** X-Edge-Cache: HIT, MISS or BYPASS. */
  edge: string | null;
  /** X-Sigma-Degraded: the part the page was rendered without. */
  degraded: string | null;
}

export interface RequestLogEntry {
  level: RequestLogLevel;
  ts: string;
  ipHash: string | null;
  method: string;
  path: string;
  status: number;
  ms: number;
  q_present: boolean;
  q_len: number;
  edge: string | null;
  degraded: string | null;
}

export type LoggedFetchHandler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response>;

const LOG_IP_FALLBACK = 'unknown';
const LOG_IP_HASH_HEX_LENGTH = 16;

let cachedKeyMaterial: string | null = null;
let cachedKeyPromise: Promise<CryptoKey> | null = null;

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP')?.trim() || LOG_IP_FALLBACK;
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function logKeyMaterial(env: RequestLogEnv): string | null {
  const key = env.LOG_IP_KEY?.trim();
  return key ? key : null;
}

function importedLogKey(keyMaterial: string): Promise<CryptoKey> {
  if (cachedKeyMaterial === keyMaterial && cachedKeyPromise) return cachedKeyPromise;

  cachedKeyMaterial = keyMaterial;
  cachedKeyPromise = crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return cachedKeyPromise;
}

export function querySummary(url: string): Pick<RequestLogEntry, 'q_present' | 'q_len'> {
  const q = new URL(url).searchParams.get('q')?.trim() ?? '';
  return {
    q_present: q.length > 0,
    q_len: q.length,
  };
}

export async function ipHash(request: Request, env: RequestLogEnv): Promise<string | null> {
  const keyMaterial = logKeyMaterial(env);
  if (!keyMaterial) return null;

  const key = await importedLogKey(keyMaterial);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(clientIp(request)),
  );
  return hex(signature).slice(0, LOG_IP_HASH_HEX_LENGTH);
}

export function logLevel(status: number, degraded: string | null): RequestLogLevel {
  if (status >= 500) return 'error';
  return degraded ? 'warn' : 'info';
}

export function servedBy(response: Response): ServedBy {
  return {
    edge: response.headers.get('X-Edge-Cache'),
    degraded: response.headers.get('X-Sigma-Degraded'),
  };
}

const UNSERVED: ServedBy = { edge: null, degraded: null };

export async function buildRequestLogEntry(
  request: Request,
  env: RequestLogEnv,
  status: number,
  ms: number,
  now = Date.now(),
  served: ServedBy = UNSERVED,
): Promise<RequestLogEntry> {
  return {
    level: logLevel(status, served.degraded),
    ts: new Date(now).toISOString(),
    ipHash: await ipHash(request, env),
    method: request.method,
    path: new URL(request.url).pathname,
    status,
    ms,
    ...querySummary(request.url),
    ...served,
  };
}

export async function emitRequestLog(
  request: Request,
  env: RequestLogEnv,
  status: number,
  ms: number,
  now = Date.now(),
  served: ServedBy = UNSERVED,
): Promise<void> {
  try {
    const entry = await buildRequestLogEntry(request, env, status, ms, now, served);
    const line = JSON.stringify(entry);
    if (entry.level === 'error') console.error(line);
    else if (entry.level === 'warn') console.warn(line);
    else console.log(line);
  } catch {
    // Logging must not affect the served response.
  }
}

export function queueRequestLog(
  ctx: ExecutionContext,
  request: Request,
  env: RequestLogEnv,
  status: number,
  ms: number,
  now = Date.now(),
  served: ServedBy = UNSERVED,
): void {
  try {
    ctx.waitUntil(emitRequestLog(request, env, status, ms, now, served));
  } catch {
    // Logging must not affect the served response.
  }
}

export async function withRequestLog(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  handler: LoggedFetchHandler,
): Promise<Response> {
  const startedAt = Date.now();
  let status = 500;
  let served = UNSERVED;

  try {
    const response = await handler(request, env, ctx);
    status = response.status;
    served = servedBy(response);
    return response;
  } finally {
    const endedAt = Date.now();
    queueRequestLog(ctx, request, env, status, endedAt - startedAt, endedAt, served);
  }
}
