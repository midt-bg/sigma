/** Comparison only; original source names and frontend presentation stay separate. */
export const personNameKey = (value: unknown): string =>
  String(value ?? '')
    .normalize('NFC')
    .toUpperCase()
    .match(/\p{L}+/gu)
    ?.join(' ') ?? '';

/** A register can put a collective holder under one personal-looking identifier. */
export function collectivePersonName(value: string): boolean {
  if (/наследници|наследствена общност|съсобственици/iu.test(value)) return true;
  return (
    value
      .split(/[,;\n]|\s+и\s+/iu)
      .filter((part) => personNameKey(part).split(' ').filter(Boolean).length >= 2).length > 1
  );
}
export const personalRegistryIndent = (id: string, type: string | null): boolean =>
  /^[a-f0-9]{64}$/i.test(id) && ['EGN', 'LNCH'].includes((type ?? '').toUpperCase());
