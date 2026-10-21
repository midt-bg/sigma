// Sort key for the „име" lists. A plain `ORDER BY name` is SQLite's BINARY (code-point) order: names
// in registry quotes sort first and capitals before small letters; SQLite's upper() folds ASCII only.
// The key upper-cases Cyrillic too, drops quote marks, a dash between words, leading punctuation and a
// leading ЕТ/ДЗЗД, and keeps 64 characters so a cursor built on it stays short. The Bulgarian alphabet
// is in code-point order (А…Я = U+0410…U+042F), so the folded key reads А→Я.
//
// SQLite's parser overflows at about 25 nested calls, so the replace() steps are spread over stacked
// derived tables, a few per layer; only the outermost column is read.
// ponytail: computed per row on every name-sorted page, so that sort reads the whole rollup (no index);
// store the key as a rollup column with an index if those reads ever matter.

export const NAME_KEY = 'name_key';

const LEADING = `' -.,()'''`; // a SQL literal: the doubled quote is one apostrophe

function replaceAll(expr: string, pairs: [string, string][]): string {
  return pairs.reduce((s, [from, to]) => `replace(${s}, '${from}', '${to}')`, expr);
}

const CYRILLIC: [string, string][] = Array.from({ length: 32 }, (_, i) => [
  String.fromCharCode(0x430 + i),
  String.fromCharCode(0x410 + i),
]);

const LAYERS: ((k: string) => string)[] = [
  (k) =>
    replaceAll(
      `upper(${k})`,
      ['"', '„', '“', '”', '«', '»'].map((q) => [q, '']),
    ),
  ...[0, 8, 16, 24].map((i) => (k: string) => replaceAll(k, CYRILLIC.slice(i, i + 8))),
  (k) =>
    `ltrim(${replaceAll(k, [
      [' - ', ' '],
      [' – ', ' '],
    ])}, ${LEADING})`,
  (k) =>
    `substr(ltrim(substr(${k}, CASE WHEN ${k} LIKE 'ЕТ %' THEN 4 WHEN ${k} LIKE 'ДЗЗД %' THEN 6 ELSE 1 END), ${LEADING}), 1, 64)`,
];

/** `from` (a table or a derived table with a `name` column) plus a `name_key` column. */
export function withNameKey(from: string): string {
  let src = from;
  let prev = 'name';
  LAYERS.forEach((layer, i) => {
    const out = i === LAYERS.length - 1 ? NAME_KEY : `name_k${i}`;
    src = `(SELECT *, ${layer(prev)} AS ${out} FROM ${src})`;
    prev = out;
  });
  return src;
}
