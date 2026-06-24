// E5 — Guard C: CPV interpretation mapping.
//
// When the user names a sector in words ("строителство", "храни"), the assistant must map it to CPV
// divisions EXPLICITLY against the catalog taxonomy in @sigma/config — never by free-form guessing —
// and record the mapping in the callout. A word that resolves to one curated division is reported
// unambiguously; a word that resolves to a multi-division category (or is unrecognized) is flagged
// `ambiguous` so the model states the assumption instead of silently picking one reading.

import { CPV_CATEGORIES, CPV_SECTORS } from '@sigma/config';

export type CpvMatchType = 'sector' | 'category' | 'unknown';

export interface SectorMapping {
  input: string;
  normalized: string;
  /** 2-digit CPV division codes, in catalog order. Empty when unknown. */
  divisions: string[];
  ambiguous: boolean;
  matchType: CpvMatchType;
  /** The explicit assumption made, in Bulgarian, suitable for surfacing to the reader. */
  assumption: string;
  /** Mapping record for the report callout. */
  callout: string;
}

function normalize(word: string): string {
  return word.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Explicit, catalog-grounded word → division (single CPV division).
const SECTOR_BY_WORD = new Map<string, string>();
for (const sector of CPV_SECTORS) {
  SECTOR_BY_WORD.set(normalize(sector.label), sector.code);
}
for (const sector of CPV_SECTORS) {
  if (sector.short) SECTOR_BY_WORD.set(normalize(sector.short), sector.code);
}

// Explicit, curated synonyms — deliberate, not heuristic. Word → division.
const SECTOR_SYNONYMS: Record<string, string> = {
  строеж: '45',
  'строителни работи': '45',
  'хранителни продукти': '15',
  храна: '15',
};
for (const [word, code] of Object.entries(SECTOR_SYNONYMS)) {
  SECTOR_BY_WORD.set(normalize(word), code);
}

// Explicit word → category key (multi-division group).
const CATEGORY_BY_WORD = new Map<string, string>();
for (const category of CPV_CATEGORIES) {
  CATEGORY_BY_WORD.set(normalize(category.key), category.key);
  CATEGORY_BY_WORD.set(normalize(category.label), category.key);
}
const CATEGORY_SYNONYMS: Record<string, string> = {
  инфраструктура: 'construction',
  здравеопазване: 'health',
  ит: 'it-telecom',
  софтуер: 'it-telecom',
  енергетика: 'energy',
  транспорт: 'transport',
};
for (const [word, key] of Object.entries(CATEGORY_SYNONYMS)) {
  CATEGORY_BY_WORD.set(normalize(word), key);
}

const SECTOR_LABEL = new Map(CPV_SECTORS.map((s) => [s.code, s.label] as const));
const CATEGORY_BY_DIVISION = new Map<string, (typeof CPV_CATEGORIES)[number]>();
for (const category of CPV_CATEGORIES) {
  for (const division of category.divisions) CATEGORY_BY_DIVISION.set(division, category);
}

function sectorMapping(input: string, normalized: string, code: string): SectorMapping {
  const label = SECTOR_LABEL.get(code) ?? code;
  const category = CATEGORY_BY_DIVISION.get(code);
  const related = category?.divisions.filter((d) => d !== code) ?? [];
  const relatedNote =
    related.length > 0
      ? ` Свързани раздели ${related.join('/')} не са включени по подразбиране.`
      : '';
  const assumption = `Приех '${input}' = CPV раздел ${code} (${label}).${relatedNote}`;
  return {
    input,
    normalized,
    divisions: [code],
    ambiguous: false,
    matchType: 'sector',
    assumption,
    callout: assumption,
  };
}

function categoryMapping(input: string, normalized: string, key: string): SectorMapping {
  const category = CPV_CATEGORIES.find((c) => c.key === key)!;
  const divisions = [...category.divisions];
  const ambiguous = divisions.length > 1;
  const assumption = `Приех '${input}' = категория ${category.label} (CPV раздели ${divisions.join(', ')}).`;
  return {
    input,
    normalized,
    divisions,
    ambiguous,
    matchType: 'category',
    assumption,
    callout: ambiguous ? `${assumption} Уточнете при нужда.` : assumption,
  };
}

function unknownMapping(input: string, normalized: string): SectorMapping {
  const assumption = `Не разпознах сектор '${input}'; не приложих CPV филтър — уточнете.`;
  return {
    input,
    normalized,
    divisions: [],
    ambiguous: true,
    matchType: 'unknown',
    assumption,
    callout: assumption,
  };
}

/**
 * Map a word sector to CPV divisions explicitly. Single-division sector words resolve
 * unambiguously; category words resolve to several divisions with `ambiguous: true`; unrecognized
 * words surface an assumption and apply no filter. Deterministic.
 */
export function mapSectorWord(word: string): SectorMapping {
  const normalized = normalize(word);
  if (!normalized) return unknownMapping(word, normalized);

  const sectorCode = SECTOR_BY_WORD.get(normalized);
  if (sectorCode) return sectorMapping(word, normalized, sectorCode);

  const categoryKey = CATEGORY_BY_WORD.get(normalized);
  if (categoryKey) return categoryMapping(word, normalized, categoryKey);

  return unknownMapping(word, normalized);
}
