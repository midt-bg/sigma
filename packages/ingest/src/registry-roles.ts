// A partida's people and owners, as registered (ADR-0041): who manages, represents, owns and controls the
// company, each fact with the entry that added it and, once struck off, the entry that removed it.
//
// The register stores a role field as entries of records: an entry adds records (a manager, a partner, an
// actual owner) and a later entry with operation Erase strikes records it names by their RecordID. A record
// carries its holder as `Person` or `Subject` — the same shape either way: Indent, IndentType, Name, the
// country, the legal form. What Indent holds depends on IndentType:
//
//   EGN, LNCH, BirthDate   the register's salted hash of the personal number — a natural person
//   UIC                    the entity's ЕИК
//   Undefined, or empty    a raw string (a foreign number, a date, nothing) — identifies no one
//
// The share sits beside the holder: `share` (and `currency`) on a partner's record; on an actual owner's, the
// size of each owned right in OwnedRightsDetails, or the OwnedRights text.
import type { RegistryDeed, RegistryField } from './registry';

export type RegistryRoleKind =
  | 'manager'
  | 'representative'
  | 'chair'
  | 'board_of_directors'
  | 'management_board'
  | 'supervisory_board'
  | 'controlling_board'
  | 'partner'
  | 'sole_owner'
  | 'trader'
  | 'procurator'
  | 'branch_manager'
  | 'liquidator'
  | 'trustee'
  | 'beneficial_owner';

/** The register fields that name a holder, and the role each one records. */
export const ROLE_FIELDS: Readonly<Record<string, RegistryRoleKind>> = {
  '00070': 'manager',
  '00090': 'chair',
  '00100': 'representative',
  '00120': 'board_of_directors',
  '00130': 'management_board',
  '00140': 'supervisory_board',
  '00150': 'controlling_board',
  '00180': 'trader',
  '00190': 'partner',
  '00200': 'partner',
  '00210': 'partner',
  '00230': 'sole_owner',
  '00231': 'sole_owner',
  '00410': 'procurator',
  '00530': 'branch_manager',
  '05020': 'liquidator',
  '05030': 'representative',
  '05500': 'beneficial_owner',
  '09120': 'trustee',
};

export interface RegistryRole {
  eik: string;
  fieldIdent: string;
  recordId: string;
  role: RegistryRoleKind;
  subjectKind: 'person' | 'entity';
  /** The register's person identifier, or the entity's ЕИК — its name when it has none. */
  subjectId: string;
  subjectName: string;
  share: string | null;
  country: string | null;
  entryNumber: string;
  addedOn: string;
  removedOn: string | null;
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
const PERSON_INDENT = new Set(['EGN', 'LNCH', 'BIRTHDATE']);
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
function subjectOf(
  eik: string,
  holder: Obj,
): { kind: 'person' | 'entity'; id: string; name: string; indentType: string | null } | null {
  const name = str(holder.Name);
  if (!name) return null;
  const indent = str(holder.Indent);
  const indentType = str(holder.IndentType);
  const type = indentType?.toUpperCase() ?? '';
  if (indent && PERSON_INDENT.has(type) && HASH.test(indent))
    return { kind: 'person', id: indent.toLowerCase(), name, indentType };
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

/** Every role fact of a partida, from its full history, with the persons it names. */
export function rolesFromDeed(
  eik: string,
  partida: RegistryDeed,
): { roles: RegistryRole[]; persons: RegistryPerson[] } {
  const fields: RegistryField[] = partida.deed.subDeeds.flatMap((s) => s.fields);
  const byKey = new Map<string, RegistryRole>();
  const persons = new Map<string, RegistryPerson>();
  // Oldest first, so a later entry — a correction, an erase — lands after what it acts on.
  const ordered = [...fields].sort(
    (a, b) => a.entryDate.localeCompare(b.entryDate) || a.entryNumber.localeCompare(b.entryNumber),
  );
  for (const f of ordered) {
    const role = ROLE_FIELDS[f.fieldIdent];
    if (!role) continue;
    for (const rec of records(f.value)) {
      const recordId = str(rec.RecordID);
      if (!recordId) continue;
      if (f.operation === 'Erase') {
        for (const r of byKey.values())
          if (r.fieldIdent === f.fieldIdent && r.recordId === recordId && !r.removedOn)
            r.removedOn = day(f.entryDate);
        continue;
      }
      for (const holder of holders(rec)) {
        const s = subjectOf(eik, holder);
        if (!s) continue;
        const key = `${f.fieldIdent}|${recordId}|${s.id}`;
        if (!byKey.has(key))
          byKey.set(key, {
            eik,
            fieldIdent: f.fieldIdent,
            recordId,
            role,
            subjectKind: s.kind,
            subjectId: s.id,
            subjectName: s.name,
            share: shareOf(rec),
            country: countryOf(rec, holder),
            entryNumber: f.entryNumber,
            addedOn: day(f.entryDate),
            removedOn: null,
          });
        // Only a person the register identifies by its hash is a person across companies.
        if (s.kind === 'person' && !s.id.startsWith('local:'))
          persons.set(s.id, { indent: s.id, name: s.name, indentType: s.indentType });
      }
    }
  }
  return { roles: [...byKey.values()], persons: [...persons.values()] };
}
