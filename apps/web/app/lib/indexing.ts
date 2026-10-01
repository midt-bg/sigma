/** The one address search engines should index: the production site. Stage, dev and the production Worker's
 *  own workers.dev address serve the same pages; they tell crawlers to stay away instead of competing with it
 *  — and instead of inviting a crawl of a test database, which is what overloaded stage on 28.09.2026. */
export const INDEXED_HOSTS: ReadonlySet<string> = new Set(['sigma.midt.bg']);

export function isIndexedHost(target: Request | URL | string): boolean {
  const url = target instanceof Request ? new URL(target.url) : new URL(String(target));
  return INDEXED_HOSTS.has(url.hostname);
}
