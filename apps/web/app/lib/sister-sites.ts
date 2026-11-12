/** The public address of СИГМА Бюджет, the sister site on the state budget, from the `BUDGET_URL` setting
 *  (apps/web/wrangler.jsonc). Empty, malformed or not https gives null, and every link to the site is left
 *  out — so СИГМА can ship before the budget site's address answers, and the links appear the day the
 *  setting is filled in. The trailing slash is dropped from a bare origin, so the link reads as typed. */
export function budgetUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return url.pathname === '/' && !url.search && !url.hash ? url.origin : url.href;
}
