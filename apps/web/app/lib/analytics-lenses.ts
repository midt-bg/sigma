// Lens definitions for the analytics hub. Display text (title/desc) is not stored here — it lives in
// the `analytics` namespace keyed by `key` (analytics.lens.<key>.title / .desc), so callers render via
// t(). Only the stable key and the Bulgarian-rooted href live here.
export const ANALYTICS_LENSES = [
  { key: 'flows', href: '/flows' },
  { key: 'map', href: '/map' },
  { key: 'trends', href: '/trends' },
  { key: 'competition', href: '/competition' },
] as const;

export const ANALYTICS_NAV_PATHS = [
  '/analytics',
  ...ANALYTICS_LENSES.map((lens) => lens.href),
  '/network',
] as const;
