// A Cyrillic reading of a query typed in Latin letters, offered on /search when nothing matched — e.g. a
// Bulgarian name typed the way it is often spelled in Latin. The table is modelled on the usual Bulgarian
// Latin spellings, but going back is approximate and ambiguous (one Latin spelling can stand for several
// Cyrillic ones, and a Latin word may be a real foreign name), so it is only a suggestion: the page links
// to it and never searches it in place of what was typed.
//
// Not phonetic AI and not a dictionary: a fixed table, longest letter group first. Only whole words of
// Latin letters are read; anything with a digit (ЕИК, УНП, „T446583"), a Cyrillic letter (the homoglyph
// case search already handles), or the look of an address („www.", „://", „@", „a.b") is kept as typed.

// Multi-letter groups first, so „sht" is never read as „s"+„h"+„t". „ia" at the end of a word is read
// as „ия", the usual Latin spelling of that ending (България → Bulgaria).
const GROUPS: [RegExp, string][] = [
  [/sht/g, 'щ'],
  [/zh/g, 'ж'],
  [/ch/g, 'ч'],
  [/sh/g, 'ш'],
  [/ts/g, 'ц'],
  [/yu/g, 'ю'],
  [/ya/g, 'я'],
  [/yo/g, 'йо'],
  [/ck/g, 'к'],
  [/ia$/g, 'ия'],
];

const LETTERS: Record<string, string> = {
  a: 'а',
  b: 'б',
  c: 'к',
  d: 'д',
  e: 'е',
  f: 'ф',
  g: 'г',
  h: 'х',
  i: 'и',
  j: 'дж',
  k: 'к',
  l: 'л',
  m: 'м',
  n: 'н',
  o: 'о',
  p: 'п',
  r: 'р',
  s: 'с',
  t: 'т',
  u: 'у',
  v: 'в',
  w: 'в',
  x: 'кс',
  y: 'й',
  z: 'з',
};

const LATIN_WORD = /^[a-z]+(?:['’-][a-z]+)*$/i;
const ADDRESS = /:\/\/|^www\.|@|[\p{L}\d]\.[\p{L}\d]/u;

/** One Latin word in Cyrillic, or null when a letter has no reading (e.g. „q"). */
export function latinWordToCyrillic(word: string): string | null {
  let s = word.toLowerCase();
  for (const [group, cyr] of GROUPS) s = s.replace(group, cyr);
  let out = '';
  for (const ch of s) {
    if (/[a-z]/.test(ch)) {
      const cyr = LETTERS[ch];
      if (!cyr) return null;
      out += cyr;
    } else {
      out += ch; // already-read groups, the apostrophe, the hyphen
    }
  }
  return out;
}

/**
 * The Cyrillic query to suggest for `typed`, or null when there is nothing worth offering: no Latin word
 * in it, a Latin word with a letter that has no reading, or a result that is not different from the query.
 */
export function cyrillicSuggestion(typed: string): string | null {
  const words = typed.trim().split(/\s+/).filter(Boolean);
  let changed = false;
  const out: string[] = [];
  for (const word of words) {
    if (ADDRESS.test(word) || !LATIN_WORD.test(word) || word.length < 2) {
      out.push(word);
      continue;
    }
    const cyr = latinWordToCyrillic(word);
    if (cyr == null) return null;
    out.push(cyr);
    changed = true;
  }
  if (!changed) return null;
  const suggestion = out.join(' ');
  return suggestion.toLocaleLowerCase('bg') !== typed.trim().toLocaleLowerCase('bg')
    ? suggestion
    : null;
}
