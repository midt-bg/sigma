// One URL per page. The router matches paths case-insensitively and the edge cache keys on the exact
// path, so `/Companies`, `/COMPANIES` and an upper-case person id each rendered and cached a full
// duplicate. The canonical form has no trailing slash, a lower-case route name and a lower-case
// person id. Only those are folded: company and contract slugs are case-sensitive.
export function canonicalPathname(pathname: string): string {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
  return p
    .replace(/^\/([A-Za-z][A-Za-z.-]*)(?=\/|$)/, (_, route: string) => `/${route.toLowerCase()}`)
    .replace(/^\/persons\/([0-9A-Fa-f]{64})$/, (_, id: string) => `/persons/${id.toLowerCase()}`);
}
