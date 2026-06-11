function csp(scriptSrc: string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptSrc.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

// Security response headers shared by HTML and resource routes. CSP is layered on separately:
// nonce-based for uncached SSR, hash-based for cacheable HTML stored at the edge.
export function baseSecurityHeaders(isProd: boolean): Headers {
  const headers = new Headers({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });

  if (isProd) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  return headers;
}

// Security response headers. The nonce-based CSP is enforced only in production —
// in dev, Vite injects inline scripts / HMR that a strict policy would block.
// Note: prerendered routes are served as static assets and do NOT pass through
// the SSR handler; set their headers via static-asset config if needed.
export function securityHeaders(nonce: string, isProd: boolean): Headers {
  const headers = baseSecurityHeaders(isProd);
  if (isProd) headers.set('Content-Security-Policy', csp([`'nonce-${nonce}'`]));
  return headers;
}

export function nonceLessSecurityHeaders(scriptHashes: string[], isProd: boolean): Headers {
  const headers = baseSecurityHeaders(isProd);
  if (isProd) headers.set('Content-Security-Policy', csp(scriptHashes));
  return headers;
}
