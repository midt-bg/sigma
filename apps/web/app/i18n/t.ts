import { DEFAULT_LOCALE, type Locale } from './locale';
import { MESSAGES, type Messages } from './messages';

// Dot-path keys derived from the nested catalog, e.g. 'nav.home' | 'footer.openSource'. Because the
// type is computed from `Messages`, an unknown key is a compile error and editor autocomplete lists
// every valid key.
type DotKeys<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${DotKeys<T[K]>}`;
}[keyof T & string];

export type MessageKey = DotKeys<Messages>;

type Vars = Record<string, string | number>;

function lookup(catalog: unknown, key: string): string | undefined {
  let cur: unknown = catalog;
  for (const part of key.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

export type TFunction = (key: MessageKey, vars?: Vars) => string;

/**
 * Build a translator for a locale. Pure function of (locale, key, vars) — same on server and client,
 * so SSR output and hydration always agree. Falls back to the default (Bulgarian) catalog, then to the
 * key itself, so a not-yet-translated string degrades visibly rather than rendering blank.
 */
export function makeT(locale: Locale): TFunction {
  return (key, vars) => {
    const raw = lookup(MESSAGES[locale], key) ?? lookup(MESSAGES[DEFAULT_LOCALE], key) ?? key;
    return interpolate(raw, vars);
  };
}
