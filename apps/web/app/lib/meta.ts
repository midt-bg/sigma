// Shared SEO meta helpers for route `meta()` functions.
//
// The root loader exposes `origin` for absolute URLs in social and canonical tags. During error
// boundaries or before the root loader runs, `origin` can be missing — in that case we omit
// `og:url` and the canonical link entirely rather than emitting bare paths that crawlers will
// either ignore or resolve incorrectly.

type MetaMatches = ReadonlyArray<{ id?: string; data?: unknown } | undefined> | undefined;

export function getRootOrigin(matches: MetaMatches): string | undefined {
  const data = matches?.find((m) => m?.id === 'root')?.data as { origin?: string } | undefined;
  return data?.origin || undefined;
}

export function seoMeta({
  matches,
  path,
  title,
  description,
}: {
  matches: MetaMatches;
  path: string;
  title: string;
  description: string;
}) {
  const origin = getRootOrigin(matches);
  const url = origin ? `${origin}${path}` : undefined;
  return [
    { title },
    { name: 'description', content: description },
    { property: 'og:title', content: title },
    { property: 'og:description', content: description },
    { name: 'twitter:title', content: title },
    { name: 'twitter:description', content: description },
    ...(url
      ? [
          { property: 'og:url', content: url },
          { tagName: 'link', rel: 'canonical', href: url },
        ]
      : []),
  ];
}
