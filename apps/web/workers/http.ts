import { canonicalPathname } from '../app/lib/canonical-path';
import { baseSecurityHeaders } from '../app/lib/security';

export const ALLOWED_METHODS = 'GET, HEAD';

export function redirectCleartextHttp(request: Request, isProd: boolean): Response | null {
  const url = new URL(request.url);
  if (!isProd || url.protocol !== 'http:') return null;

  url.protocol = 'https:';
  const headers = baseSecurityHeaders(isProd);
  headers.set('Location', url.toString());

  return new Response(null, {
    status: 301,
    headers,
  });
}

// The root loader redirects a non-canonical path (`/Contracts`), but the edge cache keys on the lower-case
// path and answers first, so a cached page was served under the upper-case URL. Redirect here, before the
// cache. Single-fetch `.data` requests are left to the router: the app's own links are canonical.
export function redirectToCanonicalPath(request: Request, isProd: boolean): Response | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  if (url.pathname.endsWith('.data')) return null;
  const pathname = canonicalPathname(url.pathname);
  if (pathname === url.pathname) return null;
  url.pathname = pathname;
  const headers = baseSecurityHeaders(isProd);
  headers.set('Location', url.pathname + url.search);
  return new Response(null, { status: 301, headers });
}

export function optionsResponse(isProd: boolean): Response {
  const headers = baseSecurityHeaders(isProd);
  headers.set('Allow', ALLOWED_METHODS);

  return new Response(null, {
    status: 204,
    headers,
  });
}

export function setAllowHeader(headers: Headers, status: number): void {
  if (status === 405) headers.set('Allow', ALLOWED_METHODS);
}
