// Cache-Control for public, anonymous pages: serve from the edge and revalidate
// in the background. See docs/architecture/ADR-0001 (§2 rendering).
export function publicCache(maxAgeSeconds: number, staleWhileRevalidateSeconds = 86_400): string {
  return `public, s-maxage=${maxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`;
}

// Route `headers` export for pages whose only header is that Cache-Control.
export const cached = (maxAgeSeconds: number) => () => ({
  'Cache-Control': publicCache(maxAgeSeconds),
});
