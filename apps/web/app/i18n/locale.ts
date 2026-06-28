import { DEFAULT_LOCALE, LOCALES, type Locale } from '@sigma/shared';

// Single source of truth for the active locale: the URL prefix. Bulgarian is unprefixed (`/companies`),
// English lives under `/en` (`/en/companies`). No cookie / Accept-Language negotiation — that would make
// one URL serve two bodies and break the path-keyed edge cache. These helpers are pure string functions
// (no React / react-router import) so they run identically in loaders, the worker, and unit tests.

export { DEFAULT_LOCALE, LOCALES };
export type { Locale };

const EN_PREFIX = '/en';

function toPathname(input: string): string {
  if (input.startsWith('/')) return input;
  try {
    return new URL(input).pathname;
  } catch {
    return '/' + input.replace(/^\/+/, '');
  }
}

/** Active locale from a Request, URL, or pathname — derived from the URL prefix only. */
export function getLocale(input: Request | string): Locale {
  const pathname = typeof input === 'string' ? toPathname(input) : new URL(input.url).pathname;
  return pathname === EN_PREFIX || pathname.startsWith(EN_PREFIX + '/') ? 'en' : 'bg';
}

/** Strip any locale prefix, returning the canonical Bulgarian-rooted path (always starts with `/`). */
export function stripLocale(pathname: string): string {
  if (pathname === EN_PREFIX) return '/';
  if (pathname.startsWith(EN_PREFIX + '/')) return pathname.slice(EN_PREFIX.length);
  return pathname || '/';
}

/**
 * Set the locale prefix on a path. Defensive: any existing locale prefix is stripped first, so an
 * already-localized input (`/en/companies`) is re-targeted rather than double-prefixed
 * (`/en/en/companies`). bg → unprefixed; en → `/en…`.
 */
export function localizePath(path: string, locale: Locale): string {
  const base = stripLocale(path.startsWith('/') ? path : '/' + path);
  if (locale === 'bg') return base;
  return base === '/' ? EN_PREFIX : EN_PREFIX + base;
}

/** Re-target a path (in any locale) to another locale, preserving the page. */
export function swapLocalePath(pathname: string, locale: Locale): string {
  return localizePath(pathname, locale);
}

/** BCP-47 tag for `<html lang>` / hreflang. */
export const HTML_LANG: Record<Locale, string> = { bg: 'bg', en: 'en' };

/** Open Graph locale for `og:locale`. */
export const OG_LOCALE: Record<Locale, string> = { bg: 'bg_BG', en: 'en_US' };
