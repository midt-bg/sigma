// A partida's people and owners, as registered (ADR-0041): who manages, represents, owns and controls the
// company, each fact with the entry that added it and, once struck off, the entry that removed it.
//
// The register stores a role field as entries of records: an entry adds records (a manager, a partner, an
// actual owner) and a later entry with operation Erase strikes records it names by their RecordID. A record
// carries the holder — a natural person (`Person`: the register's salted identifier, its type, the name) or a
// subject (`Subject`: a company or a person) — and, in some fields, the share and the country beside it.
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
    : isObj(v) && typeof v.$text === 'string' && v.$text.trim()
      ? v.$text.trim()
      : null;
const day = (s: string) => s.slice(0, 10);

// Natural persons are identified by the register's salted personal-number hash; anything else is an entity.
const PERSON_INDENT = new Set(['EGN', 'LNCH', 'LNC', 'PERSON']);

/** The records of one field entry: the value itself when it is a record, else every record under it. */
function records(value: unknown): Obj[] {
  if (Array.isArray(value)) return value.flatMap(records);
  if (!isObj(value)) return [];
  if ('RecordID' in value) return [value];
  return Object.values(value).flatMap(records);
}

/** The holders a record names — `Person` or `Subject`, nested however deep — with what sits beside them. */
function holders(rec: Obj): { holder: Obj; beside: Obj }[] {
  const out: { holder: Obj; beside: Obj }[] = [];
  const walk = (node: Obj) => {
    for (const [k, v] of Object.entries(node)) {
      const items = Array.isArray(v) ? v : [v];
      for (const item of items) {
        if (!isObj(item)) continue;
        if (k === 'Person' || k === 'Subject') out.push({ holder: item, beside: node });
        else walk(item);
      }
    }
  };
  walk(rec);
  return out;
}

const pick = (o: Obj, re: RegExp): string | null => {
  for (const [k, v] of Object.entries(o))
    if (re.test(k)) {
      const s = str(v);
      if (s) return s;
    }
  return null;
};

function subjectOf(
  holder: Obj,
): { kind: 'person' | 'entity'; id: string; name: string; indentType: string | null } | null {
  const name = str(holder.Name) ?? str(holder.CompanyName) ?? str(holder.FullName);
  if (!name) return null;
  const indent = str(holder.Indent);
  const indentType = str(holder.IndentType);
  if (indent && (!indentType || PERSON_INDENT.has(indentType.toUpperCase())))
    return { kind: 'person', id: indent, name, indentType };
  const uic = str(holder.UIC) ?? str(holder.Bulstat) ?? (indent && indentType ? indent : null);
  return { kind: 'entity', id: uic ?? `name:${name.toUpperCase()}`, name, indentType };
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
      for (const { holder, beside } of holders(rec)) {
        const s = subjectOf(holder);
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
            share: pick(beside, /share|percent|quota|part/i),
            country: pick(beside, /country/i) ?? pick(holder, /country/i),
            entryNumber: f.entryNumber,
            addedOn: day(f.entryDate),
            removedOn: null,
          });
        if (s.kind === 'person')
          persons.set(s.id, { indent: s.id, name: s.name, indentType: s.indentType });
      }
    }
  }
  return { roles: [...byKey.values()], persons: [...persons.values()] };
}
