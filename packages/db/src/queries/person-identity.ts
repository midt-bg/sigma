import { companySlug } from './identity';
import { publicRole, registryRead } from './registry';
import { getRegistryIdentity, getRegistryOfficials } from './person-activity';
import { getPersonDeclarations } from './declarations';

/** One scope for all sections of either person URL, including identities with no public TR role. */
export async function getPersonScope(
  db: D1Database,
  input: { indent?: string; officialId?: string },
) {
  const indent =
    input.indent ?? (input.officialId ? await getRegistryIdentity(db, input.officialId) : null);
  const officialIds = indent
    ? await getRegistryOfficials(db, indent)
    : input.officialId
      ? [input.officialId]
      : [];
  return { indent, officialIds };
}

/** Resolve old source/entity URLs from current membership, so revoked evidence can split a URL safely. */
export async function getPersonDestinations(db: D1Database, id: string) {
  try {
    const rows = await db
      .prepare(
        `SELECT DISTINCT p.id,p.name,
      CASE WHEN s.entity_id IS NULL THEN 'source' ELSE 'person' END kind,
      (SELECT count(*) FROM declarations d WHERE d.person_id=p.id) declaration_count,
      (SELECT group_concat(DISTINCT institution) FROM declarations d WHERE d.person_id=p.id) institutions
      FROM person_source_aliases a JOIN person_sources s ON s.id=a.source_id AND s.active=1 AND s.namespace='cacbg'
      JOIN persons p ON p.id=coalesce(s.entity_id,s.legacy_person_id)
      WHERE a.alias_id=? AND EXISTS(SELECT 1 FROM declarations d WHERE d.person_id=p.id)
      ORDER BY p.name,p.id`,
      )
      .bind(id)
      .all<{
        id: string;
        name: string;
        institutions: string | null;
        kind: 'person' | 'source';
        declaration_count: number;
      }>();
    return rows.results;
  } catch (e) {
    if (/no such table:?\s*person_(source_aliases|sources)/i.test(String(e))) return [];
    throw e;
  }
}

/** Every name the person's declarations were filed under, for the ids that make up one profile. */
export async function getPersonSourceNames(db: D1Database, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db
    .prepare(
      `SELECT DISTINCT s.name FROM person_sources s
       WHERE s.active=1 AND s.namespace='cacbg'
         AND coalesce(s.entity_id,s.legacy_person_id) IN (${ids.map(() => '?').join(',')})
       ORDER BY s.name`,
    )
    .bind(...ids)
    .all<{ name: string }>();
  return rows.results.map((r) => r.name);
}

/** An attributed source archive can remain readable without a published company connection. */
export async function getPersonSourceArchive(db: D1Database, id: string) {
  const person = await db
    .prepare('SELECT name FROM persons WHERE id=?')
    .bind(id)
    .first<{ name: string }>();
  if (!person) return null;
  const declarations = await getPersonDeclarations(db, id);
  return declarations.length ? { name: person.name, declarations } : null;
}

/** Old date-of-birth URLs resolve to source companies, never a combined personal profile.
 *  instr, not LIKE: a pattern carrying the 64-character identifier exceeds D1's 50-byte LIKE limit. */
export async function getRegistrySourceCompanies(db: D1Database, indent: string) {
  return registryRead(async () => {
    const rows = await db
      .prepare(
        `SELECT DISTINCT r.eik, r.subject_name name,
      coalesce(b.name,d.name,r.eik) company, b.id bidder_id, d.fetched_at AS fetchedAt
      FROM registry_roles r JOIN registry_deeds d ON d.eik=r.eik
      LEFT JOIN bidders b ON b.id='eik:'||r.eik
      WHERE r.subject_kind='person' AND r.subject_id LIKE 'local:%'
      AND instr(r.subject_id, ':birthdate:'||?||':') > 0
      AND ${publicRole('r')} ORDER BY name,company,r.eik`,
      )
      .bind(indent)
      .all<{
        eik: string;
        name: string;
        company: string;
        bidder_id: string | null;
        fetchedAt: string;
      }>();
    return rows.results.map(({ bidder_id, ...r }) => ({
      ...r,
      href: bidder_id ? `/companies/${companySlug(bidder_id)}` : null,
    }));
  }, []);
}
