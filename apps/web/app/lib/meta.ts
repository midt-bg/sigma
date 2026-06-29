// Shared SEO meta helpers for route `meta()` functions.
//
// Canonical, og:url and the hreflang alternates are emitted ONCE in root.tsx (the App element), where
// the active locale prefix and the query string are both known and correct. They are deliberately NOT
// produced here: a per-route canonical built from the Bulgarian-rooted `path` would (a) duplicate the
// root tag and (b) point every `/en` page at its Bulgarian twin, which de-indexes the English pages.
// `seoMeta` therefore only carries the page-level title/description/social text.
//
// `matches` and `path` are accepted for backward compatibility with existing callers (and so a future
// per-route absolute tag can be reintroduced without touching every route) but are intentionally unused.

type MetaMatches = ReadonlyArray<{ id?: string; data?: unknown } | undefined> | undefined;

export function getRootOrigin(matches: MetaMatches): string | undefined {
  const data = matches?.find((m) => m?.id === 'root')?.data as { origin?: string } | undefined;
  return data?.origin || undefined;
}

export function seoMeta({
  title,
  description,
}: {
  matches?: MetaMatches;
  path?: string;
  title: string;
  description: string;
}) {
  return [
    { title },
    { name: 'description', content: description },
    { property: 'og:title', content: title },
    { property: 'og:description', content: description },
    { name: 'twitter:title', content: title },
    { name: 'twitter:description', content: description },
  ];
}
