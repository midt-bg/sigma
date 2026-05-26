import type { RiskBand } from '@sigma/shared';

export const PRICE_INDEX_CATEGORIES = ['храни', 'строителство'] as const;
export type PriceIndexCategory = (typeof PRICE_INDEX_CATEGORIES)[number];

// ── Sector classification (CPV division → sector) ──────────────────────────────────
//
// A contract's sector is its CPV *division* — the first 2 digits of the 8-digit CPV code. CPV
// (Common Procurement Vocabulary, Reg. (EC) No 213/2008) nests strictly left-to-right, so the
// 2-digit division IS a deterministic, catalog-grounded sector taxonomy — no name/keyword heuristics.
// Labels are the official Bulgarian CPV division names, as they appear in our `cpv_description` data
// and the TED catalog (https://ted.europa.eu/en/simap/cpv — machine-readable cpv_2008_xml, all langs).
//
// Coverage verified against the local corpus (May 2026): every one of the 45 divisions below is
// present, together covering 190,422 contracts / 50.8 bn EUR. The two `curated` divisions — 45
// Строителство and 15 Храни — are the featured sectors that also drive the price index
// (PRICE_INDEX_CATEGORIES). See docs/mock-coverage.md.

export interface CpvSector {
  /** 2-digit CPV division code. */
  code: string;
  /** Official Bulgarian CPV division label. */
  label: string;
  /** Short display name for featured sectors (falls back to `label`). */
  short?: string;
  /** Featured sector — also drives the price index. */
  curated?: boolean;
}

// Full CPV-division taxonomy (every division seen in the corpus), in code order. Label = the division
// header's official BG name (division 14 carries the official "minerals/metals" name; the corpus only
// happens to hold its salt subgroup 14400000).
export const CPV_SECTORS: readonly CpvSector[] = [
  { code: '03', label: 'Продукти на земеделието, животновъдството, рибарството, лесовъдството и свързани с тях продукти' },
  { code: '09', label: 'Нефтопродукти, горива, електричество и други енергоизточници' },
  { code: '14', label: 'Продукти на минното дело, основни метали и свързани с тях продукти' },
  { code: '15', label: 'Хранителни продукти, напитки, тютюн и свързани с него продукти', short: 'Храни', curated: true },
  { code: '16', label: 'Селскостопански машини' },
  { code: '18', label: 'Облекло, обувни изделия, пътни артикули и аксесоари' },
  { code: '19', label: 'Кожени и текстилни изделия, пластмасови и каучукови материали' },
  { code: '22', label: 'Печатни материали и свързани с тях продукти' },
  { code: '24', label: 'Химически продукти' },
  { code: '30', label: 'Компютърни и офис машини, оборудване и принадлежности, с изключение на мебели и софтуерни пакети' },
  { code: '31', label: 'Електрически машини, уреди, оборудване и консумативи; осветление' },
  { code: '32', label: 'Радио-, телевизионно, съобщително, далекосъобщително и сродни видове оборудване' },
  { code: '33', label: 'Медицинско оборудване, фармацевтични продукти и продукти за лични грижи' },
  { code: '34', label: 'Транспортно оборудване и помощни продукти за транспортиране' },
  { code: '35', label: 'Оборудване за безопасност, противопожарно, полицейско и отбранително оборудване' },
  { code: '37', label: 'Музикални инструменти, спортни артикули, игри, играчки, занаятчийски изделия, предмети на изкуството и принадлежности' },
  { code: '38', label: 'Лабораторно, оптично и прецизно оборудване (без стъклени изделия)' },
  { code: '39', label: 'Обзавеждане (включително офис обзавеждане), мебелировка, електродомакински уреди (с изключение на осветителни тела) и продукти за почистване' },
  { code: '41', label: 'Събрана и пречистена вода' },
  { code: '42', label: 'Машини за промишлена употреба' },
  { code: '43', label: 'Минни машини, оборудване за разработване на кариери и строително оборудване' },
  { code: '44', label: 'Строителни конструкции и материали; помощни строителни материали (без електрически апарати)' },
  { code: '45', label: 'Строителни и монтажни работи', short: 'Строителство', curated: true },
  { code: '48', label: 'Софтуерни пакети и информационни системи' },
  { code: '50', label: 'Услуги по ремонт и поддръжка' },
  { code: '51', label: 'Услуги по инсталиране (с изключение на софтуер)' },
  { code: '55', label: 'Хотелиерски и ресторантьорски услуги и услуги в областта на търговията на дребно' },
  { code: '60', label: 'Транспортни услуги (с изключение на извозването на отпадъци)' },
  { code: '63', label: 'Спомагателни услуги в транспорта; услуги на туристически агенции' },
  { code: '64', label: 'Услуги на пощата и далекосъобщенията' },
  { code: '65', label: 'Обществени услуги' },
  { code: '66', label: 'Финансови и застрахователни услуги' },
  { code: '70', label: 'Услуги, свързани с недвижими имоти' },
  { code: '71', label: 'Архитектурни, строителни, инженерни и инспекционни услуги' },
  { code: '72', label: 'ИТ услуги: консултации, разработване на софтуер, Интернет и поддръжка' },
  { code: '73', label: 'Научни изследвания и експериментални разработки и свързаните с тях консултантски услуги' },
  { code: '75', label: 'Услуги на държавното управление за обществото като цяло' },
  { code: '76', label: 'Услуги, свързани с добива на нефт и газ' },
  { code: '77', label: 'Услуги, свързани със селското и горското стопанство, овощарството, аквакултурите и пчеларството' },
  { code: '79', label: 'Бизнес услуги: право, маркетинг, консултиране, набиране на персонал, печат и охрана' },
  { code: '80', label: 'Образователни и учебно-тренировъчни услуги' },
  { code: '85', label: 'Услуги на здравеопазването и социалните дейности' },
  { code: '90', label: 'Услуги, свързани с отпадъчните води, битовите отпадъци, чистотата и околната среда' },
  { code: '92', label: 'Услуги в областта на културата, спорта и развлеченията' },
  { code: '98', label: 'Други обществени, социални и персонални услуги' },
];

const CPV_SECTOR_BY_CODE = new Map<string, CpvSector>(CPV_SECTORS.map((s) => [s.code, s]));

/** Map an 8-digit CPV code to its sector (CPV division), or null if missing/unknown. Deterministic. */
export function sectorForCpv(cpvCode: string | null | undefined): CpvSector | null {
  if (!cpvCode) return null;
  return CPV_SECTOR_BY_CODE.get(cpvCode.replace(/\D/g, '').slice(0, 2)) ?? null;
}

/** The featured sectors (45 Строителство, 15 Храни) — these also drive the price index. */
export const CURATED_SECTORS: readonly CpvSector[] = CPV_SECTORS.filter((s) => s.curated);

// ── Procedure groups (ЗОП procedure_type → display group) ──────────────────────────────────────
//
// A DETERMINISTIC map of the real `tenders.procedure_type` values (verified against the corpus,
// May 2026) into the seven buckets the explorer shows. Not a heuristic — every distinct value is
// assigned explicitly. Drives the procedure filter, the "Как купува / Как печели" StackedBar, and
// the non-competitive share. `competitive`: true = open to all qualified bidders, false = direct /
// without notice, null = neutral (framework call-offs, design contests, unknown) — never asserted
// as (non)competitive. Colors are editorial design tokens (ink ramp; accent red marks the
// non-competitive bucket, the one worth the reader's eye). Counts in comments are corpus tallies.

export type ProcedureGroupKey =
  | 'open'
  | 'competition'
  | 'collection'
  | 'negotiated_invited'
  | 'direct'
  | 'other'
  | 'unknown';

export interface ProcedureGroup {
  key: ProcedureGroupKey;
  /** Short Bulgarian label for the legend / filter. */
  label: string;
  /** true = competitive, false = non-competitive, null = neutral / not asserted. */
  competitive: boolean | null;
  /** CSS colour (design token var) for the StackedBar segment + legend swatch. */
  color: string;
  /** The exact `procedure_type` values that map here. */
  types: readonly string[];
}

// Display order: most-open → least-open → neutral → unknown.
export const PROCEDURE_GROUPS: readonly ProcedureGroup[] = [
  {
    key: 'open',
    label: 'Открита',
    competitive: true,
    color: 'var(--color-ink)',
    types: [
      'Открита процедура', // 37 942
      'Ограничена процедура', // 121
      'Ограничена процедура по ДСП', // 504
      'Ограничена процедура по КС', // 66
    ],
  },
  {
    key: 'competition',
    label: 'Състезание',
    competitive: true,
    color: 'var(--color-ink-mid)',
    types: [
      'Публично състезание', // 35 423
      'Състезателна процедура с договаряне', // 20
    ],
  },
  {
    key: 'collection',
    label: 'Събиране на оферти',
    competitive: true,
    color: 'var(--color-ink-soft)',
    types: [
      'Събиране на оферти с обява', // 33 940
    ],
  },
  {
    key: 'negotiated_invited',
    label: 'Договаряне с покана',
    competitive: null,
    color: 'oklch(72% 0.05 70)',
    types: [
      'Покана до определени лица', // 2 200
      'Договаряне с предварителна покана за участие', // 954
      'Договаряне с предварителна покана за участие по КС', // 360
      'Договаряне с публикуване на обявление за поръчка', // 95
    ],
  },
  {
    key: 'direct',
    label: 'Пряко / без обявление',
    competitive: false,
    color: 'var(--color-accent)',
    types: [
      'Договаряне без предварително обявление', // 8 199
      'Пряко договаряне', // 6 925
      'Договаряне без предварителна покана за участие', // 946
      'Договаряне без публикуване на обявление за поръчка', // 89
    ],
  },
  {
    key: 'other',
    label: 'Друго',
    competitive: null,
    color: 'oklch(80% 0.03 75)',
    types: [
      'Динамична система за покупки', // 151
      'Квалификационна система', // 89
      'Конкурс за проект - открит', // 44
      'Партньорство за иновации', // 1
      'Конкурс за проект - ограничен', // 1
    ],
  },
  {
    key: 'unknown',
    label: 'Неизвестна',
    competitive: null,
    color: 'var(--color-rule)',
    types: [
      'неизвестна', // 18 954 — synthetic (contract-only) tenders; shown as its own bucket, never dropped
    ],
  },
];

const PROCEDURE_GROUP_BY_TYPE = new Map<string, ProcedureGroup>(
  PROCEDURE_GROUPS.flatMap((g) => g.types.map((t) => [t, g] as const)),
);

const PROCEDURE_UNKNOWN = PROCEDURE_GROUPS.find((g) => g.key === 'unknown')!;

/** Map a raw `procedure_type` to its display group. Unrecognised values fall to the „Неизвестна"
 *  bucket (never silently dropped). Deterministic. */
export function procedureGroup(procedureType: string | null | undefined): ProcedureGroup {
  if (!procedureType) return PROCEDURE_UNKNOWN;
  return PROCEDURE_GROUP_BY_TYPE.get(procedureType.trim()) ?? PROCEDURE_UNKNOWN;
}

// ── Entity types (bidders.kind → label) ──────────────────────────────────────────────────────────
//
// Only the two real `bidders.kind` values. The mock's ЕТ and „чуждестранно" facets are dropped — no
// real source field for them (no-heuristics rule). `is_consortium`/`kind` are real (company 13 712 /
// consortium 3 736).
export type EntityType = 'company' | 'consortium';

export const ENTITY_TYPES: Record<EntityType, string> = {
  company: 'Дружество',
  consortium: 'Обединение',
};

export interface RiskWeights {
  spec: number;
  price: number;
  competition: number;
  cartel: number;
  process: number;
}

// Weights sum to 1.0 so a fully-saturated tender scores exactly 100.
export const DEFAULT_RISK_WEIGHTS: RiskWeights = {
  spec: 0.25,
  price: 0.25,
  competition: 0.2,
  cartel: 0.2,
  process: 0.1,
};

export const RISK_BAND_LABELS: Record<RiskBand, string> = {
  low: 'Нисък',
  medium: 'Среден',
  high: 'Висок',
  critical: 'Критичен',
};

export function requireEnv(env: Record<string, unknown>, key: string): string {
  const value = env[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}
