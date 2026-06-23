export type HealthDbStatus = 'ok' | 'error';

export interface HealthPayload {
  ok: boolean;
  ts: string;
  db: HealthDbStatus;
}

export async function pingDb(db: D1Database): Promise<HealthDbStatus> {
  try {
    await db.prepare('SELECT 1 AS ok').first();
    return 'ok';
  } catch {
    return 'error';
  }
}

export function buildHealthResponse(db: HealthDbStatus, now = new Date()): Response {
  const ok = db === 'ok';
  const body: HealthPayload = {
    ok,
    ts: now.toISOString(),
    db,
  };
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 503,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
