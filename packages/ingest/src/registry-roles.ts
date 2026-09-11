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
//   EGN, LNCH, BirthDate   the register's salted hash of the personal number — a natural person
//   UIC                    the entity's ЕИК
//   Undefined, or empty    a raw string (a foreign number, a date, nothing) — identifies no one
//
// A holder is followed from entry to entry by that identity, not by the record's RecordID, which the register
// does not always keep for a holder who stays. The share sits beside the holder: `share` (and `currency`) on a
// partner's record; on an actual owner's, the size of each owned right in OwnedRightsDetails, or the
// OwnedRights text.
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

/** Every role fact of a partida, from its full history, with the persons it names. */
export function rolesFromDeed(
  eik: string,
  partida: RegistryDeed,
): { roles: RegistryRole[]; persons: RegistryPerson[] } {
  const roles: RegistryRole[] = [];
  const persons = new Map<string, RegistryPerson>();
  for (const sub of partida.deed.subDeeds) {
    const byField = new Map<string, RegistryField[]>();
    for (const f of sub.fields)
      if (ROLE_FIELDS[f.fieldIdent])
        byField.set(f.fieldIdent, [...(byField.get(f.fieldIdent) ?? []), f]);
    for (const [fieldIdent, entries] of byField) {
      const role = ROLE_FIELDS[fieldIdent]!;
      // The holders the field lists as it stands, by identity.
      const standing = new Map<string, RegistryRole>();
      for (const f of [...entries].sort(chronological)) {
        const on = day(f.entryDate);
        const now = f.operation === 'Erase' ? new Map<string, never>() : listed(eik, f.value);
        for (const [id, r] of standing)
          if (!now.has(id)) {
            r.removedOn = on;
            standing.delete(id);
          }
        for (const [id, { subject, rec, holder }] of now) {
          const share = shareOf(rec);
          const country = countryOf(rec, holder);
          const stays = standing.get(id);
          if (stays) {
            // Still listed: the role goes on, as the latest entry has it.
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
          // Only a person the register identifies by its hash is a person across companies.
          if (subject.kind === 'person' && !id.startsWith('local:'))
            persons.set(id, { indent: id, name: subject.name, indentType: subject.indentType });
        }
      }
    }
  }
  return { roles, persons: [...persons.values()] };
}
