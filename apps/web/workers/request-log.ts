export interface RequestLogEnv {
  LOG_IP_KEY?: string;
}

export interface RequestLogEntry {
  ts: string;
  ipHash: string | null;
  method: string;
  path: string;
  status: number;
  ms: number;
  q_present: boolean;
  q_len: number;
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

export async function buildRequestLogEntry(
  request: Request,
  env: RequestLogEnv,
  status: number,
  ms: number,
  now = Date.now(),
): Promise<RequestLogEntry> {
  return {
    ts: new Date(now).toISOString(),
    ipHash: await ipHash(request, env),
    method: request.method,
    path: new URL(request.url).pathname,
    status,
    ms,
    ...querySummary(request.url),
  };
}

export async function emitRequestLog(
  request: Request,
  env: RequestLogEnv,
  status: number,
  ms: number,
  now = Date.now(),
): Promise<void> {
  try {
    console.log(JSON.stringify(await buildRequestLogEntry(request, env, status, ms, now)));
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
): void {
  try {
    ctx.waitUntil(emitRequestLog(request, env, status, ms, now));
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

  try {
    const response = await handler(request, env, ctx);
    status = response.status;
    return response;
  } finally {
    const endedAt = Date.now();
    queueRequestLog(ctx, request, env, status, endedAt - startedAt, endedAt);
  }
}
