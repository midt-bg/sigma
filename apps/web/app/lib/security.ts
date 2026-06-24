function csp(scriptSrc: string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptSrc.join(' ')}`.trim(),
    // `style-src` keeps 'unsafe-inline': the only remaining inline `style=` attributes carry
    // genuinely dynamic, per-row values that cannot be enumerated as classes — chart-bar widths
    // (StackedBar, RankedBars, ShareBar, SingleOfferPortion) and the procedure-mix segment colours
    // (trusted @sigma/config tokens, never user input). A CSP nonce authorises <style>/<script>
    // ELEMENTS, not inline style ATTRIBUTES, so it cannot cover these — independent of how
    // `script-src` is enforced. All static inline styles have been migrated to classes in app.css,
    // shrinking this to a handful of injection-free numeric/colour values; with no HTML-injection
    // sink today, this stays defense-in-depth.
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
// the SSR render (entry.server.tsx) sets a per-request nonce policy; for edge-cacheable HTML the
// worker swaps that for a nonce-LESS, hash-based policy so a frozen cache entry never replays one
// nonce to every visitor for the whole s-maxage lifetime (see workers/app.ts).
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

// Cache-safe CSP for edge-cacheable HTML: a nonce is per-request and would freeze across the cache
// lifetime, so the worker instead allow-lists the SHA-256 hashes of the response's *trusted* inline
// scripts (the nonce-bearing framework scripts — see workers/app.ts). Hash sources, unlike a nonce,
// are identical for every visitor of a cached page, so no secret is replayed.
export function nonceLessSecurityHeaders(scriptHashes: string[], isProd: boolean): Headers {
  const headers = baseSecurityHeaders(isProd);
  if (isProd) headers.set('Content-Security-Policy', csp(scriptHashes));
  return headers;
}
