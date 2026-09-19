/** Display only: source spelling and identity keys must never be derived from this value. */
export function personName(name: string): string {
  // The register's own spelling carries stray runs of whitespace („МАРИЯ  ВАСИЛЕВА  КАПОН"), which show
  // as a visible gap on a page that names a person. Collapsing them changes nothing about identity —
  // the keys are built from the source value, never from this one.
  const spaced = name.trim().replace(/\s+/gu, ' ');
  // Preserve deliberate mixed casing, including particles and names such as McDonald.
  if (spaced !== spaced.toUpperCase() && spaced !== spaced.toLowerCase()) return spaced;
  return spaced
    .toLowerCase()
    .replace(/(^|[^\p{L}\p{M}])\p{L}/gu, (initial) => initial.toUpperCase());
}
