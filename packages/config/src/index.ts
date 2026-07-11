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
// Строителство and 15 Храни — are the featured sectors. See docs/core-scope.md § Сектори.

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
  {
    code: '03',
    label:
      'Продукти на земеделието, животновъдството, рибарството, лесовъдството и свързани с тях продукти',
  },
  { code: '09', label: 'Нефтопродукти, горива, електричество и други енергоизточници' },
  { code: '14', label: 'Продукти на минното дело, основни метали и свързани с тях продукти' },
  {
    code: '15',
    label: 'Хранителни продукти, напитки, тютюн и свързани с него продукти',
    short: 'Храни',
    curated: true,
  },
  { code: '16', label: 'Селскостопански машини' },
  { code: '18', label: 'Облекло, обувни изделия, пътни артикули и аксесоари' },
  { code: '19', label: 'Кожени и текстилни изделия, пластмасови и каучукови материали' },
  { code: '22', label: 'Печатни материали и свързани с тях продукти' },
  { code: '24', label: 'Химически продукти' },
  {
    code: '30',
    label:
      'Компютърни и офис машини, оборудване и принадлежности, с изключение на мебели и софтуерни пакети',
  },
  { code: '31', label: 'Електрически машини, уреди, оборудване и консумативи; осветление' },
  {
    code: '32',
    label: 'Радио-, телевизионно, съобщително, далекосъобщително и сродни видове оборудване',
  },
  { code: '33', label: 'Медицинско оборудване, фармацевтични продукти и продукти за лични грижи' },
  { code: '34', label: 'Транспортно оборудване и помощни продукти за транспортиране' },
  {
    code: '35',
    label: 'Оборудване за безопасност, противопожарно, полицейско и отбранително оборудване',
  },
  {
    code: '37',
    label:
      'Музикални инструменти, спортни артикули, игри, играчки, занаятчийски изделия, предмети на изкуството и принадлежности',
  },
  { code: '38', label: 'Лабораторно, оптично и прецизно оборудване (без стъклени изделия)' },
  {
    code: '39',
    label:
      'Обзавеждане (включително офис обзавеждане), мебелировка, електродомакински уреди (с изключение на осветителни тела) и продукти за почистване',
  },
  { code: '41', label: 'Събрана и пречистена вода' },
  { code: '42', label: 'Машини за промишлена употреба' },
  {
    code: '43',
    label: 'Минни машини, оборудване за разработване на кариери и строително оборудване',
  },
  {
    code: '44',
    label:
      'Строителни конструкции и материали; помощни строителни материали (без електрически апарати)',
  },
  { code: '45', label: 'Строителни и монтажни работи', short: 'Строителство', curated: true },
  { code: '48', label: 'Софтуерни пакети и информационни системи' },
  { code: '50', label: 'Услуги по ремонт и поддръжка' },
  { code: '51', label: 'Услуги по инсталиране (с изключение на софтуер)' },
  {
    code: '55',
    label: 'Хотелиерски и ресторантьорски услуги и услуги в областта на търговията на дребно',
  },
  { code: '60', label: 'Транспортни услуги (с изключение на извозването на отпадъци)' },
  { code: '63', label: 'Спомагателни услуги в транспорта; услуги на туристически агенции' },
  { code: '64', label: 'Услуги на пощата и далекосъобщенията' },
  { code: '65', label: 'Обществени услуги' },
  { code: '66', label: 'Финансови и застрахователни услуги' },
  { code: '70', label: 'Услуги, свързани с недвижими имоти' },
  { code: '71', label: 'Архитектурни, строителни, инженерни и инспекционни услуги' },
  { code: '72', label: 'ИТ услуги: консултации, разработване на софтуер, Интернет и поддръжка' },
  {
    code: '73',
    label:
      'Научни изследвания и експериментални разработки и свързаните с тях консултантски услуги',
  },
  { code: '75', label: 'Услуги на държавното управление за обществото като цяло' },
  { code: '76', label: 'Услуги, свързани с добива на нефт и газ' },
  {
    code: '77',
    label:
      'Услуги, свързани със селското и горското стопанство, овощарството, аквакултурите и пчеларството',
  },
  {
    code: '79',
    label: 'Бизнес услуги: право, маркетинг, консултиране, набиране на персонал, печат и охрана',
  },
  { code: '80', label: 'Образователни и учебно-тренировъчни услуги' },
  { code: '85', label: 'Услуги на здравеопазването и социалните дейности' },
  {
    code: '90',
    label: 'Услуги, свързани с отпадъчните води, битовите отпадъци, чистотата и околната среда',
  },
  { code: '92', label: 'Услуги в областта на културата, спорта и развлеченията' },
  { code: '98', label: 'Други обществени, социални и персонални услуги' },
];

// ── CPV category groups (curated partition over CPV divisions) ─────────────────────────────────
//
// CPV has no official level above the 2-digit division, so these top-level categories are a
// deterministic editorial PARTITION over the 45 divisions above — the same spirit as
// PROCEDURE_GROUPS below. This is not a name/keyword heuristic: every division is assigned
// explicitly to exactly one group.

export interface CpvCategory {
  /** Stable ASCII key (URL/test friendly). */
  key: string;
  /** Bulgarian display name. */
  label: string;
  /** 2-digit CPV division codes in this category. */
  divisions: readonly string[];
}

export const CPV_CATEGORIES: readonly CpvCategory[] = [
  {
    key: 'construction',
    label: 'Строителство и инфраструктура',
    divisions: ['45', '44', '43', '71'],
  },
  {
    key: 'health',
    label: 'Здравеопазване и социални дейности',
    divisions: ['33', '85'],
  },
  {
    key: 'food-agri',
    label: 'Храни и земеделие',
    divisions: ['15', '03', '16', '77'],
  },
  {
    key: 'energy',
    label: 'Енергетика, горива и суровини',
    divisions: ['09', '76', '14'],
  },
  {
    key: 'it-telecom',
    label: 'ИТ, телекомуникации и електроника',
    divisions: ['48', '72', '30', '32', '64'],
  },
  {
    key: 'transport',
    label: 'Транспорт и логистика',
    divisions: ['34', '60', '63'],
  },
  {
    key: 'industry',
    label: 'Индустрия, машини и поддръжка',
    divisions: ['42', '31', '38', '50', '51', '24', '19'],
  },
  {
    key: 'environment',
    label: 'Околна среда и комунални услуги',
    divisions: ['90', '65', '41'],
  },
  {
    key: 'business',
    label: 'Бизнес, финанси и администрация',
    divisions: ['79', '66', '70', '73', '75', '22'],
  },
  {
    key: 'security',
    label: 'Сигурност и отбрана',
    divisions: ['35'],
  },
  {
    key: 'goods',
    label: 'Стоки, обзавеждане и потребление',
    divisions: ['39', '18', '37'],
  },
  {
    key: 'education',
    label: 'Образование, култура и услуги',
    divisions: ['80', '92', '55', '98'],
  },
];

const CPV_CATEGORY_BY_DIVISION = new Map<string, CpvCategory>(
  CPV_CATEGORIES.flatMap((category) =>
    category.divisions.map((division) => [division, category] as const),
  ),
);

/** Map a CPV division/full code to its curated top-level category, or null if missing/unknown. */
export function categoryForDivision(division: string | null | undefined): CpvCategory | null {
  if (!division) return null;
  return CPV_CATEGORY_BY_DIVISION.get(division.replace(/\D/g, '').slice(0, 2)) ?? null;
}

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
    color: 'oklch(0.50 0.16 255)',
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
    color: 'oklch(0.64 0.13 195)',
    types: [
      'Публично състезание', // 35 423
      'Състезателна процедура с договаряне', // 20
    ],
  },
  {
    key: 'collection',
    label: 'Събиране на оферти',
    competitive: true,
    color: 'oklch(0.57 0.16 150)',
    types: [
      'Събиране на оферти с обява', // 33 940
    ],
  },
  {
    key: 'negotiated_invited',
    label: 'Договаряне с покана',
    competitive: null,
    color: 'oklch(0.72 0.15 80)',
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
    color: 'oklch(0.52 0.19 320)',
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
    color: 'oklch(0.70 0.02 250)',
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

// ── Bulgarian regions (NUTS3) ────────────────────────────────────────────────────────────────────
//
// The 28 области (NUTS3), grouped into the 6 NUTS2 planning regions. Mirrors scripts/load-nuts.sql
// (the DB seed), kept here as the front-end source of truth for the /map choropleth: names, NUTS3
// ids (join the bg-region-geometry asset) and macro-region grouping. `name` must match
// authorities.region verbatim (both come from the same NUTS table) so the spend aggregation keys cleanly.

export interface BgRegion {
  /** NUTS3 id, e.g. 'BG411'; joins the map geometry in apps/web/app/lib/bg-region-geometry.ts. */
  nuts3: string;
  /** Region name, verbatim as in authorities.region (e.g. 'София (столица)'). */
  name: string;
  /** NUTS2 macro-region id. */
  nuts2: string;
  /** NUTS2 macro-region name. */
  nuts2Name: string;
}

export const BG_REGIONS: readonly BgRegion[] = [
  { nuts3: 'BG311', name: 'Видин', nuts2: 'BG31', nuts2Name: 'Северозападен' },
  { nuts3: 'BG312', name: 'Монтана', nuts2: 'BG31', nuts2Name: 'Северозападен' },
  { nuts3: 'BG313', name: 'Враца', nuts2: 'BG31', nuts2Name: 'Северозападен' },
  { nuts3: 'BG314', name: 'Плевен', nuts2: 'BG31', nuts2Name: 'Северозападен' },
  { nuts3: 'BG315', name: 'Ловеч', nuts2: 'BG31', nuts2Name: 'Северозападен' },
  { nuts3: 'BG321', name: 'Велико Търново', nuts2: 'BG32', nuts2Name: 'Северен централен' },
  { nuts3: 'BG322', name: 'Габрово', nuts2: 'BG32', nuts2Name: 'Северен централен' },
  { nuts3: 'BG323', name: 'Русе', nuts2: 'BG32', nuts2Name: 'Северен централен' },
  { nuts3: 'BG324', name: 'Разград', nuts2: 'BG32', nuts2Name: 'Северен централен' },
  { nuts3: 'BG325', name: 'Силистра', nuts2: 'BG32', nuts2Name: 'Северен централен' },
  { nuts3: 'BG331', name: 'Варна', nuts2: 'BG33', nuts2Name: 'Североизточен' },
  { nuts3: 'BG332', name: 'Добрич', nuts2: 'BG33', nuts2Name: 'Североизточен' },
  { nuts3: 'BG333', name: 'Шумен', nuts2: 'BG33', nuts2Name: 'Североизточен' },
  { nuts3: 'BG334', name: 'Търговище', nuts2: 'BG33', nuts2Name: 'Североизточен' },
  { nuts3: 'BG341', name: 'Бургас', nuts2: 'BG34', nuts2Name: 'Югоизточен' },
  { nuts3: 'BG342', name: 'Сливен', nuts2: 'BG34', nuts2Name: 'Югоизточен' },
  { nuts3: 'BG343', name: 'Ямбол', nuts2: 'BG34', nuts2Name: 'Югоизточен' },
  { nuts3: 'BG344', name: 'Стара Загора', nuts2: 'BG34', nuts2Name: 'Югоизточен' },
  { nuts3: 'BG411', name: 'София (столица)', nuts2: 'BG41', nuts2Name: 'Югозападен' },
  { nuts3: 'BG412', name: 'София', nuts2: 'BG41', nuts2Name: 'Югозападен' },
  { nuts3: 'BG413', name: 'Благоевград', nuts2: 'BG41', nuts2Name: 'Югозападен' },
  { nuts3: 'BG414', name: 'Перник', nuts2: 'BG41', nuts2Name: 'Югозападен' },
  { nuts3: 'BG415', name: 'Кюстендил', nuts2: 'BG41', nuts2Name: 'Югозападен' },
  { nuts3: 'BG421', name: 'Пловдив', nuts2: 'BG42', nuts2Name: 'Южен централен' },
  { nuts3: 'BG422', name: 'Хасково', nuts2: 'BG42', nuts2Name: 'Южен централен' },
  { nuts3: 'BG423', name: 'Пазарджик', nuts2: 'BG42', nuts2Name: 'Южен централен' },
  { nuts3: 'BG424', name: 'Смолян', nuts2: 'BG42', nuts2Name: 'Южен централен' },
  { nuts3: 'BG425', name: 'Кърджали', nuts2: 'BG42', nuts2Name: 'Южен централен' },
];

const BG_REGION_BY_NAME = new Map(BG_REGIONS.map((r) => [r.name, r] as const));

/** Resolve an authorities.region name to its NUTS3 region, or null if unknown/unattributed. */
export function regionByName(name: string | null | undefined): BgRegion | null {
  if (!name) return null;
  return BG_REGION_BY_NAME.get(name.trim()) ?? null;
}
