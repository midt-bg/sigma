// A partida's people and owners, as registered (ADR-0041): who manages, represents, owns and controls the
// company, each fact with the entry that added it and, once it stopped, the day of the entry that ended it.
//
// The register keeps a role field as a sequence of entries, per sub-partida (the company, or one of its
// branches). An Add entry lists the field's holders in full, as they stand after it — not only the ones it
// adds — so a holder's role ends at the first later entry of the field that leaves them out. An Erase entry
// carries no records: it removes the whole field. The current state is the last entry of each field.
//
// A record carries its holder as `Person` or `Subject` — the same shape either way: Indent, IndentType, Name,
// the country, the legal form. What Indent holds depends on IndentType:
//
//   EGN, LNCH             a hashed personal identifier — joinable across companies
//   BirthDate             a date of birth — not a globally unique person identifier
//   UIC                    the entity's ЕИК
//   Undefined, or empty    a raw string (a foreign number, a date, nothing) — identifies no one
//
// A holder is followed from entry to entry by that identity, not by the record's RecordID, which the register
// does not always keep for a holder who stays. The share sits beside the holder: `share` (and `currency`) on a
// partner's record; on an actual owner's, the size of each owned right in OwnedRightsDetails, or the
// OwnedRights text.
import type { RegistryDeed, RegistryField } from './registry';
import {
  collectivePersonName,
  personNameKey,
  personalRegistryIndent,
} from '../../shared/src/person-identity';

export type RegistryRoleKind =
  | 'manager'
  | 'representative'
  | 'chair'
  | 'board_of_directors'
  | 'management_board'
  | 'governing_body'
  | 'board_of_trustees'
  | 'supervisory_board'
  | 'controlling_board'
  | 'verification_commission'
  | 'partner'
  | 'sole_owner'
  | 'trader'
  | 'procurator'
  | 'branch_manager'
  | 'liquidator'
  | 'trustee'
  | 'beneficial_owner';

/**
 * The register fields that name a holder, and the role each one records. The key is the field's ident, not
 * the number its form shows: „10. Представители" is 00100 for a company, 00101 for a partnership, and a
 * non-profit's „10а. Представляващи" is 00103.
 */
export const ROLE_FIELDS: Readonly<Record<string, RegistryRoleKind>> = {
  '00070': 'manager',
  '00071': 'manager', // събирателно и командитно дружество: лица, на които е възложено управлението
  '00090': 'chair',
  '00100': 'representative',
  '00101': 'representative', // събирателно и командитно дружество
  '00102': 'representative', // клон на чуждестранен търговец
  '00103': 'representative', // сдружение, фондация, читалище: представляващи
  '00120': 'board_of_directors',
  '00125': 'governing_body', // сдружение, фондация: органи на управление
  '00130': 'management_board',
  '00131': 'management_board', // кооперация
  '00132': 'management_board', // акционерно дружество с надзорен съвет
  '00135': 'board_of_trustees', // читалище: настоятелство
  '00140': 'supervisory_board',
  '00150': 'controlling_board',
  '00151': 'controlling_board', // кооперация
  '00152': 'verification_commission', // читалище: проверителна комисия
  '00180': 'trader',
  '00190': 'partner',
  '00200': 'partner',
  '00201': 'partner', // европейско обединение по икономически интереси
  '00210': 'partner',
  '00230': 'sole_owner',
  '00231': 'sole_owner',
  '00410': 'procurator',
  '00530': 'branch_manager',
  '05020': 'liquidator',
  '05030': 'representative',
  '05500': 'beneficial_owner',
  '09120': 'trustee',
  '09122': 'trustee', // синдик по производство пред по-горна инстанция
  '09123': 'trustee',
};

export interface RegistryRole {
  eik: string;
  /** The sub-partida the field belongs to: the company itself, or one of its branches. */
  subUic: string;
  fieldIdent: string;
  role: RegistryRoleKind;
  subjectKind: 'person' | 'entity';
  /** The register's person identifier, or the entity's ЕИК — its name when it has none. */
  subjectId: string;
  subjectName: string;
  share: string | null;
  country: string | null;
  /** The entry that added the holder to the field. */
  entryNumber: string;
  addedOn: string;
  /** The day of the first later entry that left the holder out or erased the field; null while it stands. */
  removedOn: string | null;
  /** The first ambiguous entry; this is not a legal removal date. */
  uncertainAfter?: string | null;
}

export interface RegistryPerson {
  indent: string;
  name: string;
  indentType: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim()
    ? v.trim()
    : typeof v === 'number' && Number.isFinite(v)
      ? String(v)
      : isObj(v) && typeof v.$text === 'string' && v.$text.trim()
        ? v.$text.trim()
        : null;
const day = (s: string) => s.slice(0, 10);

// A natural person is identified by the register's salted hash of the personal number; 64 hex characters.
const HASH = /^[0-9a-f]{64}$/i;
const EIK = /^\d{9}(\d{4})?$/;

/** The records of one field entry: the value itself when it is a record, else every record under it. */
function records(value: unknown): Obj[] {
  if (Array.isArray(value)) return value.flatMap(records);
  if (!isObj(value)) return [];
  if ('RecordID' in value) return [value];
  return Object.values(value).flatMap(records);
}

// The holders a record names: its own `Person` or `Subject`, one or several. A person nested deeper — one
// who represents the holder, say — is not the holder.
function holders(rec: Obj): Obj[] {
  return [rec.Person, rec.Subject].flatMap((v) => (Array.isArray(v) ? v : [v])).filter(isObj);
}

// The holder as an identity. A person the register identifies by its hash is joinable across companies; a
// person it does not (Undefined, empty) is known only inside this partida, so the id says so and nothing
// joins on it. An entity is its ЕИК, or its name where it has none (a foreign company).
interface Subject {
  kind: 'person' | 'entity';
  id: string;
  name: string;
  indentType: string | null;
}

function subjectOf(eik: string, holder: Obj): Subject | null {
  const name = str(holder.Name);
  if (!name) return null;
  const indent = str(holder.Indent);
  const indentType = str(holder.IndentType);
  const type = indentType?.toUpperCase() ?? '';
  if (indent && personalRegistryIndent(indent, indentType))
    return { kind: 'person', id: indent.toLowerCase(), name, indentType };
  // Birth dates are not globally unique person identifiers. Keep the role scoped to its source.
  if (indent && type === 'BIRTHDATE' && HASH.test(indent))
    return {
      kind: 'person',
      id: `local:${eik}:birthdate:${indent.toLowerCase()}:${name}`,
      name,
      indentType,
    };
  if (indent && type === 'UIC' && EIK.test(indent))
    return { kind: 'entity', id: indent, name, indentType };
  const company =
    str(holder.LegalForm) ?? str(holder.ForeignLegalFormCode) ?? str(holder.RegistrationNumber);
  if (company || type === 'UIC')
    return { kind: 'entity', id: `name:${name.toUpperCase()}`, name, indentType };
  return { kind: 'person', id: `local:${eik}:${name.toUpperCase()}`, name, indentType };
}

/** The share as registered: a partner's `share` (with its currency), else an actual owner's right sizes. */
function shareOf(rec: Obj): string | null {
  const share = str(rec.share);
  if (share) {
    const currency = str(rec.currency);
    return currency ? `${share} ${currency}` : share;
  }
  const details = isObj(rec.OwnedRightsDetails)
    ? rec.OwnedRightsDetails.OwnedRightsDetail
    : undefined;
  const sizes = (Array.isArray(details) ? details : details ? [details] : [])
    .map((d) => (isObj(d) ? str(d.OwnedRightSize) : null))
    .filter((v): v is string => Boolean(v));
  if (sizes.length) return sizes.join('; ');
  return str(rec.OwnedRights);
}

/** The country: where an actual owner resides, else the holder's own country. */
function countryOf(rec: Obj, holder: Obj): string | null {
  const residence = isObj(rec.CountryOfResidence) ? str(rec.CountryOfResidence.Country) : null;
  return residence ?? str(holder.CountryName);
}

/** The holders an entry lists, by identity, each once, with the record each sits in. */
function listed(
  eik: string,
  value: unknown,
): Map<string, { subject: Subject; rec: Obj; holder: Obj }> {
  const out = new Map<string, { subject: Subject; rec: Obj; holder: Obj }>();
  for (const rec of records(value))
    for (const holder of holders(rec)) {
      const subject = subjectOf(eik, holder);
      if (subject && !out.has(subject.id)) out.set(subject.id, { subject, rec, holder });
    }
  return out;
}

/** Oldest first, so each entry lands after the ones it follows. */
const chronological = (a: RegistryField, b: RegistryField) =>
  a.entryDate.localeCompare(b.entryDate) || a.entryNumber.localeCompare(b.entryNumber);

export interface RegistryIdentityObservation {
  eik: string;
  subUic: string;
  fieldIdent: string;
  entryNumber: string;
  entryOn: string;
  holderIndex: number;
  indent: string | null;
  indentType: string | null;
  name: string;
  nameKey: string;
  kind: 'person' | 'collective' | 'other';
}

/** Preserve per-entry names independently of the compact role intervals. */
export function identityObservations(
  eik: string,
  partida: RegistryDeed,
): RegistryIdentityObservation[] {
  const out: RegistryIdentityObservation[] = [];
  for (const sub of partida.deed.subDeeds)
    for (const f of sub.fields) {
      if (!ROLE_FIELDS[f.fieldIdent] || f.operation === 'Erase') continue;
      let holderIndex = 0;
      for (const rec of records(f.value))
        for (const holder of holders(rec)) {
          const name = str(holder.Name);
          if (!name) continue;
          const rawId = str(holder.Indent) ?? '';
          const indentType = str(holder.IndentType);
          const personal = personalRegistryIndent(rawId, indentType);
          out.push({
            eik,
            subUic: sub.subUic,
            fieldIdent: f.fieldIdent,
            entryNumber: f.entryNumber,
            entryOn: f.entryDate,
            holderIndex: holderIndex++,
            indent: personal ? rawId.toLowerCase() : null,
            indentType,
            name,
            nameKey: personNameKey(name),
            kind: personal ? (collectivePersonName(name) ? 'collective' : 'person') : 'other',
          });
        }
    }
  const holderNames = new Map<string, Set<string>>();
  const keyOf = (o: RegistryIdentityObservation) =>
    `${o.subUic}|${o.fieldIdent}|${o.entryNumber}|${o.indent}`;
  for (const o of out)
    if (o.indent) {
      const key = keyOf(o);
      if (!holderNames.has(key)) holderNames.set(key, new Set());
      holderNames.get(key)!.add(o.nameKey);
    }
  for (const o of out) if (o.indent && holderNames.get(keyOf(o))!.size > 1) o.kind = 'collective';
  return out;
}

/** Every role fact of a partida, with the original identity observations. */
export function rolesFromDeed(
  eik: string,
  partida: RegistryDeed,
): {
  roles: RegistryRole[];
  persons: RegistryPerson[];
  observations: RegistryIdentityObservation[];
} {
  const roles: RegistryRole[] = [];
  const persons = new Map<string, RegistryPerson & { observedOn: string }>();
  const observations = identityObservations(eik, partida);
  const collectiveIds = new Map<string, Set<string>>();
  for (const o of observations)
    if (o.kind === 'collective' && o.indent) {
      const key = `${o.subUic}|${o.fieldIdent}|${o.entryNumber}`;
      if (!collectiveIds.has(key)) collectiveIds.set(key, new Set());
      collectiveIds.get(key)!.add(o.indent);
    }
  for (const sub of partida.deed.subDeeds) {
    const byField = new Map<string, RegistryField[]>();
    for (const f of sub.fields)
      if (ROLE_FIELDS[f.fieldIdent])
        byField.set(f.fieldIdent, [...(byField.get(f.fieldIdent) ?? []), f]);
    for (const [fieldIdent, entries] of byField) {
      const role = ROLE_FIELDS[fieldIdent]!;
      const standing = new Map<string, RegistryRole>();
      for (const f of [...entries].sort(chronological)) {
        const on = day(f.entryDate);
        const now = f.operation === 'Erase' ? new Map<string, never>() : listed(eik, f.value);
        const ambiguous =
          collectiveIds.get(`${sub.subUic}|${fieldIdent}|${f.entryNumber}`) ?? new Set<string>();
        for (const [id, item] of now)
          if (
            item.subject.kind === 'person' &&
            (collectivePersonName(item.subject.name) || ambiguous.has(id))
          )
            now.delete(id);
        for (const [id, r] of standing)
          if (!now.has(id)) {
            if (ambiguous.has(id)) r.uncertainAfter = on;
            else r.removedOn = on;
            standing.delete(id);
          }
        for (const [id, { subject, rec, holder }] of now) {
          const share = shareOf(rec);
          const country = countryOf(rec, holder);
          const stays = standing.get(id);
          if (stays) {
            stays.subjectName = subject.name;
            stays.share = share;
            stays.country = country;
          } else {
            const added: RegistryRole = {
              eik,
              subUic: sub.subUic,
              fieldIdent,
              role,
              subjectKind: subject.kind,
              subjectId: id,
              subjectName: subject.name,
              share,
              country,
              entryNumber: f.entryNumber,
              addedOn: on,
              removedOn: null,
            };
            roles.push(added);
            standing.set(id, added);
          }
          if (subject.kind === 'person' && !id.startsWith('local:')) {
            const prior = persons.get(id);
            if (
              !prior ||
              f.entryDate > prior.observedOn ||
              (f.entryDate === prior.observedOn && subject.name.localeCompare(prior.name) < 0)
            )
              persons.set(id, {
                indent: id,
                name: subject.name,
                indentType: subject.indentType,
                observedOn: f.entryDate,
              });
          }
        }
      }
    }
  }
  return {
    roles,
    persons: [...persons.values()].map(({ observedOn: _, ...p }) => p),
    observations,
  };
}

/** The fields that record who owns the company: its partners, its sole owner, the trader himself. */
export const OWNERSHIP_FIELDS: readonly string[] = [
  '00180',
  '00190',
  '00200',
  '00201',
  '00210',
  '00230',
  '00231',
];
/** The field that records its managers. */
export const MANAGER_FIELD = '00070';
/** The registered seat. */
const SEAT_FIELD = '00050';

/** What the evidence for a declared stake reads from a partida besides its people. */
export interface RegistryDeedFacts {
  /** The settlement of the registered seat, as registered („гр. Варна") — nothing else of the address. */
  seatSettlement: string | null;
  /** The day of the entry that registered the seat as it stands. */
  seatEntryOn: string | null;
  /** The day of the latest entry across the ownership fields that stand. */
  ownersEntryOn: string | null;
}

/** The seat, and the date of the ownership record, as they stand: the last entry of each field decides. */
export function deedFacts(partida: RegistryDeed): RegistryDeedFacts {
  const facts: RegistryDeedFacts = { seatSettlement: null, seatEntryOn: null, ownersEntryOn: null };
  for (const sub of partida.deed.subDeeds) {
    const last = new Map<string, RegistryField>();
    for (const f of sub.fields) {
      const prev = last.get(f.fieldIdent);
      if (!prev || chronological(prev, f) < 0) last.set(f.fieldIdent, f);
    }
    for (const [ident, f] of last) {
      if (f.operation === 'Erase') continue;
      if (ident === SEAT_FIELD && sub.subUicType === 'MainCircumstances') {
        const address = isObj(f.value) && isObj(f.value.Address) ? f.value.Address : null;
        facts.seatSettlement = address ? str(address.Settlement) : null;
        facts.seatEntryOn = day(f.entryDate);
      }
      if (OWNERSHIP_FIELDS.includes(ident)) {
        const on = day(f.entryDate);
        if (!facts.ownersEntryOn || on > facts.ownersEntryOn) facts.ownersEntryOn = on;
      }
    }
  }
  return facts;
}
