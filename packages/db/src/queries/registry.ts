// The Trade Register layer as the site shows it (ADR-0039): who manages, represents and owns a company, and
// where a person holds a role. Facts as registered — the role, the share where the field carries one, the entry
// that added it and the day it ended — read from the tables the daily ETL keeps (ADR-0041).
//
// Only the roles in PUBLIC_ROLES leave these reads. The tables also hold the actual owners (field 05500): every
// read here filters them out, and a person the register records only as one has no page.
import type {
  CompanyPeople,
  CompanyRole,
  CompanyTieEdge,
  CompanyTieNode,
  PersonProfile,
  PersonRole,
  RegistryRoleKind,
  RoleHolder,
} from '@sigma/api-contract';
import { cleanName } from '@sigma/shared';
import { companySlug, registryPersonSlug } from './identity';
import { companyNode, personNode } from './tie-node';

/** The roles the site shows, in the order a reader looks for them: who runs the company, then who owns it. */
export const PUBLIC_ROLES: readonly RegistryRoleKind[] = [
  'manager',
  'representative',
  'chair',
  'board_of_directors',
  'management_board',
  'governing_body',
  'board_of_trustees',
  'supervisory_board',
  'controlling_board',
  'verification_commission',
  'procurator',
  'branch_manager',
  'liquidator',
  'trustee',
  'trader',
  'sole_owner',
  'partner',
];

/** The gate on a `registry_roles` alias: the row is a role the site shows. */
export const publicRole = (alias: string): string =>
  `${alias}.role IN (${PUBLIC_ROLES.map((r) => `'${r}'`).join(', ')})`;

/** The gate for a person the register identifies by its hash; the others are known only inside one partida. */
export const joinablePerson = (alias: string): string =>
  `${alias}.subject_kind = 'person' AND ${alias}.subject_id NOT LIKE 'local:%'`;

/** A role's place in PUBLIC_ROLES: the more senior, the lower. */
export function roleRank(role: RegistryRoleKind): number {
  const i = PUBLIC_ROLES.indexOf(role);
  return i < 0 ? PUBLIC_ROLES.length : i;
}

/** Roles, each once, most senior first. */
export function orderRoles(roles: Iterable<RegistryRoleKind>): RegistryRoleKind[] {
  return [...new Set(roles)].sort((a, b) => roleRank(a) - roleRank(b));
}

/** The partida ЕИК of a bidder, or null: the register is read for companies with a 9-digit ЕИК. */
export function partidaEik(bidderId: string): string | null {
  return /^eik:\d{9}$/.test(bidderId) ? bidderId.slice(4) : null;
}

/**
 * A read of the registry tables — or `empty` in an environment that does not have them yet. They come with a
 * migration of their own, and a profile must not fail for want of a layer it only adds to.
 */
export async function registryRead<T>(read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (/no such table:?\s*registry_/i.test(e instanceof Error ? e.message : String(e)))
      return empty;
    throw e;
  }
}

/** A role tie: `from` holds the roles at `to`. Not monetary, so never sized by money. */
export function roleEdge(
  from: string,
  to: string,
  roles: Iterable<RegistryRoleKind>,
  current: boolean,
  directed: boolean,
): CompanyTieEdge {
  const ordered = orderRoles(roles);
  return {
    from,
    to,
    kind: 'role',
    directed,
    weightEur: 0,
    occurrences: ordered.length,
    href: null,
    roles: ordered,
    current,
  };
}

interface Standing {
  role: RegistryRoleKind;
  addedOn: string;
  removedOn: string | null;
  uncertainAfter?: string | null;
}

/** Standing roles first, most senior first; then the ended ones, the latest ended first. */
function byStanding<T extends Standing>(name: (x: T) => string) {
  return (a: T, b: T): number => {
    const aEnd = a.removedOn ?? a.uncertainAfter;
    const bEnd = b.removedOn ?? b.uncertainAfter;
    if (!aEnd !== !bEnd) return aEnd ? 1 : -1;
    if (aEnd && bEnd && aEnd !== bEnd) return bEnd.localeCompare(aEnd);
    return (
      roleRank(a.role) - roleRank(b.role) ||
      a.addedOn.localeCompare(b.addedOn) ||
      name(a).localeCompare(name(b), 'bg')
    );
  };
}

interface CompanyRoleRow {
  role: RegistryRoleKind;
  subject_kind: 'person' | 'entity';
  subject_id: string;
  subject_name: string;
  person_name: string | null;
  entity_bidder: string | null;
  share: string | null;
  country: string | null;
  entry_number: string;
  added_on: string;
  removed_on: string | null;
  uncertain_after: string | null;
}

const COMPANY_DEED_SQL = `SELECT fetched_at FROM registry_deeds WHERE eik = ?1 AND outcome = 'ok'`;

const COMPANY_ROLES_SQL = `
  SELECT r.role, r.subject_kind, r.subject_id, r.subject_name, p.name AS person_name,
         b.id AS entity_bidder, r.share, r.country, r.entry_number, r.added_on, r.removed_on, r.uncertain_after
  FROM registry_roles r
  LEFT JOIN registry_persons p ON r.subject_kind = 'person' AND p.indent = r.subject_id
  LEFT JOIN bidders b ON r.subject_kind = 'entity' AND b.id = 'eik:' || r.subject_id
  WHERE r.eik = ?1 AND ${publicRole('r')}`;

const EIK = /^\d{9}(\d{4})?$/;

function holderOf(r: CompanyRoleRow): RoleHolder {
  if (r.subject_kind === 'person') {
    const joinable = !r.subject_id.startsWith('local:');
    return {
      kind: 'person',
      name: r.person_name ?? r.subject_name,
      href: joinable ? `/persons/${registryPersonSlug(r.subject_id)}` : null,
      eik: null,
      country: null,
    };
  }
  return {
    kind: 'entity',
    name: cleanName(r.subject_name),
    href: r.entity_bidder ? `/companies/${companySlug(r.entity_bidder)}` : null,
    eik: EIK.test(r.subject_id) ? r.subject_id : null,
    country: r.country,
  };
}

const noPeople = (): CompanyPeople => ({ roles: [], asOf: null });

/** A company's management and ownership as the register records them; empty until its partida is read. */
export async function getCompanyPeople(db: D1Database, bidderId: string): Promise<CompanyPeople> {
  const eik = partidaEik(bidderId);
  if (!eik) return noPeople();
  return registryRead(async () => {
    const [deed, rows] = await Promise.all([
      db.prepare(COMPANY_DEED_SQL).bind(eik).first<{ fetched_at: string }>(),
      db.prepare(COMPANY_ROLES_SQL).bind(eik).all<CompanyRoleRow>(),
    ]);
    if (!deed) return noPeople();
    const roles: CompanyRole[] = rows.results
      .map((r) => ({
        holder: holderOf(r),
        role: r.role,
        share: r.share,
        addedOn: r.added_on,
        removedOn: r.removed_on,
        ...(r.uncertain_after ? { uncertainAfter: r.uncertain_after } : {}),
        entryNumber: r.entry_number,
      }))
      .sort(byStanding((x) => x.holder.name));
    return { roles, asOf: deed.fetched_at.slice(0, 10) };
  }, noPeople());
}

/** Companies drawn around a person. */
const MAX_PERSON_COMPANIES = 12;

interface PersonRoleRow {
  eik: string;
  role: RegistryRoleKind;
  share: string | null;
  entry_number: string;
  added_on: string;
  removed_on: string | null;
  uncertain_after: string | null;
  deed_name: string | null;
  fetched_at: string;
  bidder_id: string | null;
  bidder_name: string | null;
  bidder_kind: 'company' | 'consortium' | null;
  won_eur: number | null;
}

const PERSON_SQL = `SELECT name FROM registry_persons WHERE indent = ?1`;

const PERSON_ROLES_SQL = `
  SELECT r.eik, r.role, r.share, r.entry_number, r.added_on, r.removed_on, r.uncertain_after, d.name AS deed_name,
         d.fetched_at, b.id AS bidder_id, b.name AS bidder_name, b.kind AS bidder_kind, ct.won_eur
  FROM registry_roles r
  JOIN registry_deeds d ON d.eik = r.eik
  JOIN bidders b ON b.id = 'eik:' || r.eik
  JOIN company_totals ct ON ct.bidder_id = b.id AND ct.contracts > 0
  WHERE r.subject_id = ?1 AND r.subject_kind = 'person' AND ${publicRole('r')}`;

/**
 * A person the register identifies, with public roles at procurement recipients with Sigma profiles — or
 * null when the identifier is unknown or has no eligible public role.
 */
export async function getRegistryPerson(
  db: D1Database,
  indent: string,
): Promise<PersonProfile | null> {
  return registryRead(async () => {
    const [person, rows] = await Promise.all([
      db.prepare(PERSON_SQL).bind(indent).first<{ name: string }>(),
      db.prepare(PERSON_ROLES_SQL).bind(indent).all<PersonRoleRow>(),
    ]);
    if (!person || rows.results.length === 0) return null;

    const roles: PersonRole[] = rows.results
      .map((r) => ({
        company: {
          name: cleanName(r.bidder_name ?? r.deed_name ?? r.eik),
          eik: r.eik,
          href: r.bidder_id ? `/companies/${companySlug(r.bidder_id)}` : null,
        },
        role: r.role,
        share: r.share,
        addedOn: r.added_on,
        removedOn: r.removed_on,
        ...(r.uncertain_after ? { uncertainAfter: r.uncertain_after } : {}),
        entryNumber: r.entry_number,
        fetchedAt: r.fetched_at,
      }))
      .sort(byStanding((x) => x.company.name));

    // The graph: the person at the centre, each company around it with the roles held there.
    const centre = personNode(indent, person.name, 0);
    const at = new Map<
      string,
      {
        name: string;
        kind: 'company' | 'consortium';
        won: number | null;
        roles: RegistryRoleKind[];
        current: boolean;
      }
    >();
    for (const r of rows.results) {
      if (!r.bidder_id || !r.bidder_name || !r.bidder_kind) continue;
      const c = at.get(r.bidder_id) ?? {
        name: r.bidder_name,
        kind: r.bidder_kind,
        won: r.won_eur,
        roles: [],
        current: false,
      };
      c.roles.push(r.role);
      c.current ||= r.removed_on === null && r.uncertain_after === null;
      at.set(r.bidder_id, c);
    }
    const ranked = [...at.entries()].sort(
      ([ia, a], [ib, b]) =>
        Number(b.current) - Number(a.current) ||
        (b.won ?? 0) - (a.won ?? 0) ||
        ia.localeCompare(ib),
    );
    const drawn = ranked.slice(0, MAX_PERSON_COMPANIES);
    const nodes: CompanyTieNode[] = [
      centre,
      ...drawn.map(([id, c]) => companyNode(id, c.name, c.kind, c.won, 0, 1)),
    ];
    const edges = drawn.map(([id, c]) => roleEdge(centre.id, id, c.roles, c.current, false));

    const won = new Map(rows.results.map((r) => [r.eik, r.won_eur ?? 0] as const));
    const lastRead = rows.results.reduce((m, r) => (r.fetched_at > m ? r.fetched_at : m), '');
    return {
      slug: registryPersonSlug(indent),
      name: person.name,
      roles,
      companies: won.size,
      wonEur: [...won.values()].reduce((sum, v) => sum + v, 0),
      asOf: lastRead ? lastRead.slice(0, 10) : null,
      network: { center: centre, nodes, edges, omitted: ranked.length - drawn.length },
    };
  }, null);
}
