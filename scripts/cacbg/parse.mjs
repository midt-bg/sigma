// Pure parsers for the CACBG register (Сметна палата, декларации по чл.75 ЗСП).
// Two templates exist, both handled here:
//   • <PublicPerson>      — asset declaration (декларация за имущество). Company SHARES in the
//                            „Дялове/Прехвърляне на дялове в дружества" tables (col 4 = company).
//   • <PublicPersonDekl2> — interests declaration (декларация за интереси). Richer: participation,
//                            MANAGEMENT/control roles, sole-trader activity, and declared related persons.
//
// No I/O — takes XML strings, returns plain records. PII is stripped at this boundary: addresses /
// passport / phone are never extracted; a non-empty EGN is surfaced as a flag; declared THIRD-PARTY
// people (related-persons/contract tables) are returned SEPARATELY (relatedPersons) so callers keep
// them internal-only (§8 — third-party data is not publishable).
//
// XXE-safe: fast-xml-parser resolves no DTDs/external entities; we also reject DOCTYPE/ENTITY input.

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false, // strings only — deterministic, no number coercion
  trimValues: true,
});

function assertNoDoctype(xml) {
  if (/<!doctype|<!entity/i.test(xml)) throw new Error('XXE guard: DOCTYPE/ENTITY not allowed');
}
const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
// Empty XML elements (<Name/>) parse to {} — String({}) would yield '[object Object]', so collapse any
// object/null/undefined to '' and trim the rest. The single coercion for every scalar field we persist.
const flat = (v) => (v == null || typeof v === 'object' ? '' : String(v).trim());
function cellText(cell) {
  if (cell == null) return '';
  const t = typeof cell === 'object' ? cell['#text'] : cell;
  return t == null ? '' : String(t).trim();
}
// map a row's cells by @_Num → text
function cellsByNum(row) {
  const by = {};
  for (const c of asArray(row?.Cell)) by[c?.['@_Num']] = cellText(c);
  return by;
}
// find the @_Num of the first column whose @_Description matches `re` (labels live on the header row)
function colNum(firstRow, re, fallback) {
  for (const c of asArray(firstRow?.Cell)) {
    if (c?.['@_Num'] && re.test(String(c?.['@_Description'] ?? ''))) return c['@_Num'];
  }
  return fallback;
}
const year4 = (s) => String(s ?? '').match(/\b(20\d{2})\b/)?.[1] ?? null;

/**
 * Parse a year's list.xml into flat person→declaration rows.
 * list.xml carries NO year (year lives inside each declaration) — do not infer it here.
 * @returns {{category:string, institution:string, person:string, position:string, xmlFile:string}[]}
 */
export function parseList(xml) {
  assertNoDoctype(xml);
  const root = parser.parse(xml)?.root;
  const out = [];
  for (const main of asArray(root?.MainCategory)) {
    for (const cat of asArray(main?.Category)) {
      const category = flat(cat?.['@_Name']);
      for (const inst of asArray(cat?.Institution)) {
        const institution = flat(inst?.['@_Name']);
        for (const person of asArray(inst?.Person)) {
          const name = flat(person?.Name);
          for (const pos of asArray(person?.Position)) {
            const position = flat(pos?.Name);
            for (const decl of asArray(pos?.Declaration)) {
              const xmlFile = flat(decl?.xmlFile);
              if (xmlFile) out.push({ category, institution, person: name, position, xmlFile });
            }
          }
        }
      }
    }
  }
  return out;
}

// --- asset declaration (<PublicPerson>): company SHARES ------------------------------------------
// TWO distinct holdings tables live here and must NOT be conflated:
//   • „Дялове в дружества с ограничена отговорност" (ООД/ЕООД) — closely-held participation shares.
//     Company in the „Наименование на дружеството" column (≈col 4). MATERIAL — where a real ownership
//     conflict lives. kind='shares'.
//   • „Ценни книги, поименни акции в акционерни дружества" (АД) — registered/listed securities.
//     Company (issuer) in the „Емитент" column (≈col 6), NOT col 4 (col 4 is „Ценни книжа"). Mostly
//     blue-chip public float — NOISE for ownership. kind='securities'.
// Each table carries a holder-name column („Име: собствено, бащино и фамилно") identifying whether the
// stake is the DECLARANT's own or a CLOSE RELATIVE's. We capture that as holderRelation ∈ self|related
// — but the relative's NAME is never retained (PII rail, §8). The materiality/legal-form gate is applied
// downstream (load.mjs closelyHeldForm), keeping this parser faithful to the source table.
function parseAssets(pp) {
  const personal = pp.Personal ?? {};
  const dd = pp.DeclarationData ?? {};
  const declarant = flat(personal.Name);
  let egnPresent = String(personal.EGN ?? '').trim().length > 0;
  const interests = [];
  let familyHoldingCount = 0;
  for (const table of asArray(pp.Tables?.Table)) {
    const desc = String(table['@_Description'] ?? '');
    const isOod = /дялове в дружества|ограничена отговорн/i.test(desc);
    const isSec = /ценни книги|акционерни дружеств|поименни акции/i.test(desc);
    if (!isOod && !isSec) continue;
    const rows = asArray(table.Row);
    const kind = isOod ? 'shares' : 'securities';
    // Column resolution is description-first (robust across template renumberings); fallbacks are the
    // observed column for that table type. Reading the wrong column is the libel risk, so the two table
    // types resolve independently — a securities table never falls back to the ООД company column.
    const cCompany = isOod
      ? colNum(rows[0], /наименование.*дружеств|фирма/i, '4')
      : colNum(rows[0], /емитент/i, '6');
    const cSeat = colNum(rows[0], /седалище/i, '5');
    const cHolder = colNum(rows[0], /собствено.*фамил/i, isOod ? '7' : '8');
    const cEgn = colNum(rows[0], /^егн$/i, isOod ? '8' : '9');
    for (const row of rows) {
      const by = cellsByNum(row);
      const company = by[cCompany] ?? '';
      if (!company) continue;
      if ((by[cEgn] ?? '').length > 0) egnPresent = true;
      const holder = by[cHolder] ?? '';
      const holderRelation = !holder || holder === declarant ? 'self' : 'related';
      if (holderRelation === 'related') familyHoldingCount += 1;
      const seat = isOod ? (by[cSeat] ?? '') : '';
      interests.push({
        entity: company,
        kind,
        detail: seat,
        timing: 'annual',
        seat,
        holderRelation,
      });
    }
  }
  return {
    templateType: 'assets',
    declarant,
    position: flat(personal.Position) || null,
    work: flat(personal.Work) || null,
    year: year4(dd.Year),
    declarationType: dd.DeclarationType != null ? String(dd.DeclarationType).trim() : null,
    controlHash: dd.ControlHash != null ? String(dd.ControlHash).trim() : null,
    egnPresent,
    familyHoldingCount,
    interests,
    relatedPersons: [],
  };
}

// --- interests declaration (<PublicPersonDekl2>): participation / MANAGEMENT / sole-trader / related
function parseInterests(ppd) {
  const personal = ppd.Personal ?? {};
  const dd = ppd.DeclarationData ?? {};
  const declarant = flat(personal.Name);
  const egnPresent = String(personal.EGN ?? '').trim().length > 0;
  const interests = [];
  const relatedPersons = []; // third-party people — INTERNAL only (§8)
  for (const table of asArray(ppd.Tables?.Table)) {
    const desc = String(table['@_Description'] ?? '');
    const rows = asArray(table.Row);
    const timing = /дванадесет месеца преди/i.test(desc) ? 'prior' : 'current';
    let kind = null;
    if (/участие в следните търговски дружества|имам участие/i.test(desc)) kind = 'participation';
    else if (/управител или член на орган|управление или контрол/i.test(desc)) kind = 'management';
    else if (
      /едноличен търговец|наименование на ет/i.test(desc) ||
      /наименование на ет/i.test(String(rows[0]?.Cell?.[1]?.['@_Description'] ?? ''))
    )
      kind = 'sole_trader';
    else if (/свързани лица/i.test(desc)) kind = 'related_person';
    else if (/договори с лица/i.test(desc)) kind = 'related_contract';
    else continue;

    if (kind === 'related_person' || kind === 'related_contract') {
      const cName = colNum(rows[0], /трите имена|име.*фамил/i, '2');
      const cInfo = colNum(rows[0], /област|предмет/i, '3');
      for (const row of rows) {
        const by = cellsByNum(row);
        const name = by[cName] ?? '';
        if (name) relatedPersons.push({ name, kind, info: by[cInfo] ?? '', timing });
      }
      continue;
    }
    // company / ЕТ bearing tables: entity name in the „Дружество" / „Наименование на ЕТ" column
    const cEntity = colNum(rows[0], /^дружество$|наименование на ет|дружеств/i, '2');
    const cDetail = colNum(rows[0], /размер|участие|предмет/i, '3');
    for (const row of rows) {
      const by = cellsByNum(row);
      const entity = by[cEntity] ?? '';
      // Interests-declaration holdings are the declarant's own (family stakes are declared separately, as
      // related persons) — holderRelation:'self' keeps the staging shape uniform with parseAssets.
      if (entity)
        interests.push({
          entity,
          kind,
          detail: by[cDetail] ?? '',
          timing,
          seat: '',
          holderRelation: 'self',
        });
    }
  }
  return {
    templateType: 'interests',
    declarant,
    position: flat(personal.Position) || null,
    work: flat(personal.Work) || null,
    year: year4(dd.DeclarationDate) ?? year4(dd.EntryDate),
    declarationType: 'interests',
    controlHash: dd.ControlHash != null ? String(dd.ControlHash).trim() : null,
    egnPresent,
    familyHoldingCount: 0,
    interests,
    relatedPersons,
  };
}

/**
 * Parse one declaration XML (either template). Detects the root and dispatches.
 * @returns unified record — see parseAssets / parseInterests. `interests[]` carry {entity, kind,
 * detail, timing}; kind ∈ shares|participation|management|sole_trader. `relatedPersons[]` are
 * third-party (INTERNAL-only). Unknown roots return an empty record (not an error).
 */
export function parseDeclaration(xml) {
  assertNoDoctype(xml);
  const doc = parser.parse(xml);
  if (doc?.PublicPerson) return parseAssets(doc.PublicPerson);
  // interests declaration ships in several template versions (PublicPersonDekl2, Dekl3, …) that differ
  // only in table NUMBERING — parseInterests classifies tables by @_Description, so it handles them all.
  const dekl = Object.keys(doc ?? {}).find((k) => /^PublicPersonDekl\d+$/.test(k));
  if (dekl) return parseInterests(doc[dekl]);
  return {
    templateType: 'unknown',
    declarant: '',
    position: null,
    work: null,
    year: null,
    declarationType: null,
    controlHash: null,
    egnPresent: false,
    familyHoldingCount: 0,
    interests: [],
    relatedPersons: [],
  };
}
