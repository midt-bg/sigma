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
