/** Display only: source spelling and identity keys must never be derived from this value. */
export function personName(name: string): string {
  // Preserve deliberate mixed casing, including particles and names such as McDonald.
  if (name !== name.toUpperCase() && name !== name.toLowerCase()) return name;
  return name.toLowerCase().replace(/(^|[^\p{L}\p{M}])\p{L}/gu, (initial) => initial.toUpperCase());
}
