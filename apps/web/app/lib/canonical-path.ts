// One URL per page. The router matches paths case-insensitively and the edge cache keys on the exact
// path, so `/Companies`, `/COMPANIES` and an upper-case person id each rendered and cached a full
// duplicate. The canonical form has no trailing slash, a lower-case route name and a lower-case
// person id. Only those are folded: company and contract slugs are case-sensitive.
export const CRAWL_FILTERED_PATHS = [
  '/authorities',
  '/companies',
  '/competition',
  '/contracts',
  '/flows',
  '/map',
  '/network',
  '/trends',
];

export function canonicalPathname(pathname: string): string {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
  return p
    .replace(/^\/[^/]*%[^/]*(?=\/|$)/, (segment) => {
      const decoded = segment.replace(/%([0-9a-f]{2})/gi, (encoded, hex: string) => {
        const char = String.fromCharCode(parseInt(hex, 16));
        return /[\w.~-]/.test(char) ? char : encoded;
      });
      const canonical = decoded.toLowerCase();
      return CRAWL_FILTERED_PATHS.includes(canonical) ? canonical : segment;
    })
    .replace(/^\/([A-Za-z][A-Za-z.-]*)(?=\/|$)/, (_, route: string) => `/${route.toLowerCase()}`)
    .replace(/^\/persons\/([0-9A-Fa-f]{64})$/, (_, id: string) => `/persons/${id.toLowerCase()}`);
}
