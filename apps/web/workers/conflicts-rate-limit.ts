import { normalizedPathname, rateLimitRequest } from './rate-limit';

interface ConflictsRateLimitEnv {
  CONFLICTS_RATE_LIMITER?: RateLimit;
}

// Every /conflicts route NAMES public officials (leaderboard, /conflicts/official/:slug,
// /conflicts/company/:eik). Unlike the other pages, this is a personal-names surface, and with `ssr: true`
// each loader also serves at `/<path>.data` — so an unauthenticated caller can enumerate
// `/conflicts/official/:slug.data` across the whole leaderboard at full speed = an unmetered bulk export
// of a names database. Throttle the whole subtree. normalizedPathname strips a trailing `.data` (and
// duplicate/trailing slashes), so the twin is covered by the SAME limit as the canonical path — it can't
// be used to bypass. The leaderboard itself is edge-cached, so cache HITs never reach this (app.ts runs the
// cache check first); only uncached distinct URLs — exactly the scrape pattern — consume the budget.
function isConflictsRequest(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const p = normalizedPathname(request);
  return p === '/conflicts' || p.startsWith('/conflicts/');
}

export async function rateLimitConflictsRoute(
  request: Request,
  env: ConflictsRateLimitEnv,
  isProd: boolean,
): Promise<Response | null> {
  if (!isConflictsRequest(request)) return null;

  // Fail CLOSED in prod: this is the ONLY anti-enumeration control on a personal-names surface, so a missing
  // or erroring binding must 503 (loudly logged) rather than silently serve `/conflicts/official/*.data` at
  // full speed — an unmetered bulk export of a names DB is a worse outcome than an intermittent 503. The
  // binding is provisioned, so this only fires on a genuine fault. Non-prod (dev/preview, binding routinely
  // absent) still degrades to a no-op so local work isn't blocked. Cached leaderboard/methodology hits never
  // reach this (app.ts runs the cache check first), so they stay up through a limiter outage.
  return rateLimitRequest(
    request,
    env.CONFLICTS_RATE_LIMITER,
    isProd,
    'Too many requests',
    'CONFLICTS_RATE_LIMITER',
    { failClosed: true },
  );
}
