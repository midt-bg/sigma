/**
 * Academic and rank titles the register writes in front of a name („д-р Иван Петров Иванов",
 * „ПРОФ. Д-Р ..."). They are presentation, not identity, and left in they are fatal to comparison:
 * `personNameKey` keeps letters only, so „д-р" becomes the two leading name components and every
 * comparison then reads the title as the given and father's name. Stripped for COMPARISON only — the
 * stored and displayed name stays exactly as the source wrote it.
 */
const PERSON_TITLE =
  /^(?:\s*(?:д-?р|доц|проф|акад|инж|арх|адв|ген|полк|подп|кап|м-?р|ст\.?\s*н\.?\s*с)\.?\s+)+/iu;
export const withoutPersonTitle = (value: unknown): string =>
  String(value ?? '')
    .normalize('NFC')
    .replace(PERSON_TITLE, '');

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

/** Levenshtein distance. */
export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/** Two adjacent letters swapped („Георгиев" → „Герогиев"). Levenshtein charges a swap as two edits, so
 * without this the commonest typing slip of all reads as a different person. Same weight as one edit. */
const transposed = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  const differing: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && differing.push(i) > 2) return false;
  const [i, j] = differing;
  return differing.length === 2 && j === i! + 1 && a[i!] === b[j!] && a[j!] === b[i!];
};

/** One name component written with a single slip: one letter changed, added or dropped, or two adjacent
 * letters swapped. Short components are excluded — in a three-letter word a single edit is a different
 * word, not a slip. */
export const oneSlipApart = (a: string, b: string): boolean =>
  a.length >= 5 && b.length >= 5 && (editDistance(a, b) <= 1 || transposed(a, b));

const typo = oneSlipApart;

/**
 * One person under two spellings of a full name: [given, father's, ...surnames]. Given and father's
 * names match exactly or by one typo, and the surnames share one — so an added or dropped surname, or
 * a misspelt surname when the other two names are exact. One typo in the whole name at most, which keeps
 * Стефан Петров and Стефана Петрова apart. A surname changed outright only with both other names exact
 * and a female father's name (-А), the case of a surname taken on marriage.
 */
export function personNamesAlike(a: string, b: string): boolean {
  const [x, y] = [a, b].map((n) => personNameKey(n).split(' ').filter(Boolean));
  if (x!.length < 3 || y!.length < 3) return false;
  const [gx, fx, ...sx] = x!;
  const [gy, fy, ...sy] = y!;
  for (const [p, q] of [
    [gx!, gy!],
    [fx!, fy!],
  ])
    if (p !== q && !typo(p!, q!)) return false;
  const typos = Number(gx !== gy) + Number(fx !== fy);
  if (sx.some((s) => sy.includes(s))) return typos <= 1;
  if (typos) return false;
  return sx.some((s) => sy.some((t) => typo(s, t))) || fx!.endsWith('А');
}
