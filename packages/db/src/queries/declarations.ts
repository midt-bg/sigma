import type { DeclaredEntryStatus, PersonDeclaration, RegistryRoleKind } from '@sigma/api-contract';
import {
  companyNamesAlike,
  declaredTextHasEik,
  officeInstitution,
  officeOrganizationEik,
  registryCompanyName,
} from '@sigma/shared';
import { declarationMatchesLink, declarationYearDisputed } from './declaration-source';
import { filingsByYear, historyNames, registryOmission } from './registry-omissions';
import { SURFACED_OWNERSHIP, NOT_REDUNDANT_FAMILY } from './related-persons';
import { publicRole } from './registry';

/** All available source documents for a surfaced declarant, including empty filings. */
export async function getPersonDeclarations(
  db: D1Database,
  personId: string,
): Promise<PersonDeclaration[]> {
  const companyPredicate = `${SURFACED_OWNERSHIP} AND ${NOT_REDUNDANT_FAMILY}`;
  const legacySource = `il.match_method='exact_name_key' AND EXISTS (SELECT 1 FROM declared_interests di
    WHERE di.declaration_id=d.id AND di.entity_key=il.entity_key)`;
  let metadata = true;
  let resolvedSources = true;
  let rows;
  for (;;) {
    const sql = `SELECT d.id, d.declared_year, d.template, d.category, d.institution, d.position, d.source_url,
      ${metadata ? 'm.declaration_type, m.declared_on, m.submitted_on' : 'NULL AS declaration_type, NULL AS declared_on, NULL AS submitted_on'},
      (SELECT json_group_array(DISTINCT il.eik) FROM interest_links il
        WHERE il.person_id=d.person_id AND ${companyPredicate}
          AND ${resolvedSources ? declarationMatchesLink() : legacySource}) AS companies
      FROM declarations d ${metadata ? 'LEFT JOIN declaration_metadata m ON m.declaration_id=d.id' : ''}
      WHERE d.person_id=? ORDER BY d.declared_year DESC, d.id DESC`;
    try {
      rows = await db.prepare(sql).bind(personId).all<Record<string, unknown>>();
      break;
    } catch (e) {
      if (metadata && /no such table:?\s*declaration_metadata/i.test(String(e))) metadata = false;
      else if (resolvedSources && /no such table:?\s*declaration_companies/i.test(String(e)))
        resolvedSources = false;
      else throw e;
    }
  }
  // Do not transmit the free-text detail field: only the named entity and the declared kind/time.
  const interests = await db
    .prepare(
      `SELECT di.declaration_id,di.entity_raw,di.kind,di.timing,
    (SELECT json_group_array(DISTINCT json_object('eik',il.eik,'scope',CASE WHEN il.interest_class='family_ownership' THEN 'family' ELSE 'self' END))
      FROM interest_links il WHERE il.person_id=d.person_id AND il.entity_key=di.entity_key
      AND ${companyPredicate} AND ${resolvedSources ? declarationMatchesLink() : legacySource}
      AND EXISTS (SELECT 1 FROM interest_link_observations o WHERE o.link_key=il.link_key
        AND o.declaration_id=d.id AND o.kind=di.kind AND o.timing=di.timing)) matches
    FROM declared_interests di JOIN declarations d ON d.id=di.declaration_id
    WHERE d.person_id=? ORDER BY di.entity_raw,di.kind,di.timing`,
    )
    .bind(personId)
    .all<{
      declaration_id: string;
      entity_raw: string;
      kind: string;
      timing: string;
      matches: string;
    }>();
  const comparisons = await db
    .prepare(
      `SELECT DISTINCT il.eik,b.name company,o.declaration_id,
    o.reported_year year,o.timing,CASE WHEN il.interest_class='family_ownership' THEN 'family' ELSE 'self' END scope
    FROM interest_links il JOIN bidders b ON b.id=il.bidder_id
    JOIN interest_link_observations o ON o.link_key=il.link_key
    WHERE il.person_id=? AND ${companyPredicate} AND o.kind='shares'
      AND o.timing IN ('annual','not_listed')
      AND ${metadata ? "EXISTS (SELECT 1 FROM declaration_metadata annual WHERE annual.declaration_id=o.declaration_id AND lower(annual.declaration_type) IN ('annualy','annual','yearly'))" : "o.timing='not_listed'"}
      AND ${declarationYearDisputed('il', 'o.reported_year')}`,
    )
    .bind(personId)
    .all<{
      eik: string;
      company: string;
      declaration_id: string;
      year: string;
      timing: string;
      scope: 'self' | 'family';
    }>();
  // Ownership the register recorded for the declarant at the end of a reporting year: the person's filings
  // for that year should name the company. Ownership only — a board seat is often held by appointment — and
  // only where the site has read the partida. Whether they name it is decided below, over every filing of
  // the year (`registryOmission`).
  const omissions = metadata
    ? await db
        .prepare(
          `SELECT d.id declaration_id, r.eik, rd.name company, rd.legal_form, r.role, r.entry_number, r.added_on
    FROM declarations d
    JOIN declaration_metadata m ON m.declaration_id=d.id AND lower(m.declaration_type) IN ('annualy','annual','yearly')
    JOIN person_entities e ON e.id=d.person_id AND e.registry_indent IS NOT NULL
    JOIN registry_roles r ON r.subject_id=e.registry_indent AND r.subject_kind='person'
      AND r.role IN ('sole_owner','partner','trader') AND r.added_on<>''
      AND date(r.added_on)<=date(d.declared_year||'-12-31')
      AND (r.removed_on IS NULL OR date(r.removed_on)>date(d.declared_year||'-12-31'))
      AND (r.uncertain_after IS NULL OR date(r.uncertain_after)>date(d.declared_year||'-12-31'))
    LEFT JOIN registry_deeds rd ON rd.eik=r.eik
    WHERE d.person_id=? AND d.declared_year IS NOT NULL
    ORDER BY d.id, r.eik, r.role`,
        )
        .bind(personId)
        .all<{
          declaration_id: string;
          eik: string;
          company: string | null;
          legal_form: string | null;
          role: RegistryRoleKind;
          entry_number: string;
          added_on: string;
        }>()
        .then((q) => q.results)
        .catch((e: unknown) => {
          if (
            /no such table:?\s*(person_entities|declaration_companies|registry_)/i.test(String(e))
          )
            return [];
          throw e;
        })
    : [];
  const filings = omissions.length
    ? await omissionEvidence(db, personId, rows.results, interests.results, omissions)
    : null;
  const tied = await tiedCompanies(db, personId);
  // The organizations the person files declarations for as a member of their bodies: a seat there is an office.
  const offices = new Set(
    rows.results.map((d) => officeOrganizationEik(d.category as string | null)).filter(Boolean),
  );
  // A filing for a seat in an organization's bodies is shown under the organization; its own „Месторабота" goes
  // beside it, verbatim (officeInstitution). The stored declaration is not touched.
  const categories = rows.results.map((d) => d.category as string | null);
  return rows.results
    .map((r) => {
      const office = officeInstitution(
        { category: r.category as string | null, institution: r.institution as string | null },
        categories,
      );
      return { r, office };
    })
    .map(({ r, office }) => ({
      id: String(r.id),
      year: r.declared_year as string | null,
      template: String(r.template),
      type: r.declaration_type as string | null,
      declaredOn: r.declared_on as string | null,
      submittedOn: r.submitted_on as string | null,
      institution: office ? office.name : (r.institution as string | null),
      position: r.position as string | null,
      ...(office
        ? { office: { basis: office.basis, work: (r.institution as string | null) || null } }
        : {}),
      url: String(r.source_url),
      interests: interests.results
        .filter((i) => i.declaration_id === r.id)
        .map((i) => {
          const matches = JSON.parse(i.matches) as { eik: string; scope: 'self' | 'family' }[];
          const eiks = new Set(matches.map((m) => m.eik));
          const scopes = new Set(matches.map((m) => m.scope));
          return (
            (matches.length === 0 &&
              declaredEntry(
                i,
                tied.filter((t) => t.declarationId === r.id),
                offices,
              )) || {
              company: i.entity_raw,
              kind: i.kind,
              timing: i.timing,
              eik: eiks.size === 1 ? matches[0]!.eik : null,
              scope: scopes.size === 1 ? matches[0]!.scope : ('unknown' as const),
            }
          );
        }),
      discrepancies: comparisons.results
        .filter((c) => c.declaration_id === r.id)
        .map((c) => ({
          eik: c.eik,
          company: c.company,
          year: c.year,
          scope: c.scope,
          listed: c.timing === 'annual',
          otherDeclarationIds: [
            ...new Set(
              comparisons.results
                .filter(
                  (other) =>
                    other.eik === c.eik &&
                    other.scope === c.scope &&
                    other.year === c.year &&
                    other.timing !== c.timing,
                )
                .map((other) => other.declaration_id),
            ),
          ],
        })),
      companyEiks: JSON.parse(String(r.companies ?? '[]')) as string[],
      // A company any filing of the year names — by ЕИК, under its current or a former name, in any
      // spelling — is named; a year of which nothing was read gives no note at all.
      registryOmissions: omissions.flatMap((o) => {
        if (o.declaration_id !== r.id || !filings) return [];
        const omission = registryOmission(filings.byYear, String(r.declared_year), {
          eik: o.eik,
          names: [o.company, ...(filings.history.get(o.eik) ?? [])],
        });
        if (!omission) return [];
        return [
          {
            eik: o.eik,
            company: o.company ? registryCompanyName(o.company, o.legal_form) : o.eik,
            role: o.role,
            entryNumber: o.entry_number,
            addedOn: o.added_on,
            ...(omission.earlierYear ? { earlierYear: omission.earlierYear } : {}),
          },
        ];
      }),
    }))
    .sort(
      (a, b) =>
        (b.year ?? '').localeCompare(a.year ?? '') ||
        (b.submittedOn ?? b.declaredOn ?? '').localeCompare(a.submittedOn ?? a.declaredOn ?? '') ||
        a.id.localeCompare(b.id),
    );
}

/** What every filing of the person says, pooled by year, and the register's former names of the companies
 *  a note might be about. The resolver's ЕИК and the register history are optional tables: without them the
 *  comparison rests on the entries' text alone. */
async function omissionEvidence(
  db: D1Database,
  personId: string,
  declarations: Record<string, unknown>[],
  interests: { declaration_id: string; entity_raw: string }[],
  omissions: { eik: string }[],
) {
  const optional = <T>(query: Promise<{ results: T[] }>) =>
    query
      .then((q) => q.results)
      .catch((e: unknown) => {
        if (/no such table:?\s*(declaration_companies|registry_company_history)/i.test(String(e)))
          return [] as T[];
        throw e;
      });
  const [resolved, history] = await Promise.all([
    optional(
      db
        .prepare(
          `SELECT dc.declaration_id, dc.eik FROM declaration_companies dc
          JOIN declarations d ON d.id=dc.declaration_id WHERE d.person_id=?`,
        )
        .bind(personId)
        .all<{ declaration_id: string; eik: string }>(),
    ),
    optional(
      db
        .prepare(
          `SELECT eik, names_json FROM registry_company_history WHERE eik IN (SELECT value FROM json_each(?))`,
        )
        .bind(JSON.stringify([...new Set(omissions.map((o) => o.eik))]))
        .all<{ eik: string; names_json: string }>(),
    ),
  ]);
  return {
    byYear: filingsByYear(
      declarations.map((d) => ({
        year: (d.declared_year as string | null) ?? null,
        eiks: resolved.filter((c) => c.declaration_id === d.id).map((c) => c.eik),
        named: interests.filter((i) => i.declaration_id === d.id).map((i) => i.entity_raw),
      })),
    ),
    history: new Map(history.map((h) => [h.eik, historyNames(h.names_json)])),
  };
}

/** A company the resolver tied to one of the person's filings, and what Sigma established about it. */
interface TiedCompany {
  declarationId: string;
  eik: string;
  names: string[];
  ownershipKind: string | null;
  legalForm: string | null;
  links: { status: string; class: string; tier: string; surfaced: number }[];
  roles: RegistryRoleKind[];
}

/** The register's codes for a joint-stock company: it does not record the shareholders. */
const JOINT_STOCK_FORMS = new Set(['AD', 'EAD', 'KDA', 'ADSITS']);

/** Every company the resolver tied to one of the person's filings, with the person's links to it, their
 *  roles in its partida as the register records them, its names and its legal form. */
async function tiedCompanies(db: D1Database, personId: string): Promise<TiedCompany[]> {
  const rows = await db
    .prepare(
      `SELECT dc.declaration_id, dc.eik, b.name bidder, b.ownership_kind, rd.name registry_name, rd.legal_form,
      h.names_json history,
      (SELECT json_group_array(json_object('status',il.status,'class',il.interest_class,'tier',il.publish_tier,
          'surfaced',${SURFACED_OWNERSHIP}))
        FROM interest_links il WHERE il.person_id=d.person_id AND il.eik=dc.eik) links,
      (SELECT json_group_array(DISTINCT r.role) FROM person_entities e JOIN registry_roles r
        ON r.subject_id=e.registry_indent AND r.subject_kind='person' AND r.eik=dc.eik
        WHERE e.id=d.person_id AND e.registry_indent IS NOT NULL AND ${publicRole('r')}) roles
    FROM declarations d JOIN declaration_companies dc ON dc.declaration_id=d.id
    JOIN bidders b ON b.id='eik:'||dc.eik
    LEFT JOIN registry_deeds rd ON rd.eik=dc.eik
    LEFT JOIN registry_company_history h ON h.eik=dc.eik
    WHERE d.person_id=?`,
    )
    .bind(personId)
    .all<{
      declaration_id: string;
      eik: string;
      bidder: string;
      ownership_kind: string | null;
      registry_name: string | null;
      legal_form: string | null;
      history: string | null;
      links: string;
      roles: string;
    }>()
    .then((q) => q.results)
    .catch((e: unknown) => {
      if (
        /no such (table|column):?\s*(declaration_companies|registry_\w+|person_entities|\w*\.?(publish_tier|ownership_kind|names_json))/i.test(
          String(e),
        )
      )
        return [];
      throw e;
    });
  return rows.map((t) => ({
    declarationId: t.declaration_id,
    eik: t.eik,
    names: [
      t.bidder,
      t.registry_name ? registryCompanyName(t.registry_name, t.legal_form) : null,
      ...historyNames(t.history),
    ].filter((n): n is string => !!n),
    ownershipKind: t.ownership_kind,
    legalForm: t.legal_form,
    links: JSON.parse(t.links) as TiedCompany['links'],
    roles: (JSON.parse(t.roles) as (RegistryRoleKind | null)[]).filter(
      (r): r is RegistryRoleKind => !!r,
    ),
  }));
}

/**
 * An entry the declaration states about a company with procurement, shown although it is not counted among
 * the related persons — with what Sigma established about it, and nothing more. An entry whose company has a
 * counted tie the name match above did not reach (a spelling the name key does not fold — a dash, a quote) is
 * counted, and says so: no status. Null leaves the entry as it was:
 *   - it names none, or more than one, of the companies tied to its filing (no spelling of a name, no ЕИК);
 *   - a link to the company was taken down on an objection;
 *   - the seat is the person's office — in a public enterprise, or in the organization they file for as a
 *     member of its bodies: it stands with the offices at the top, not again here.
 * The company page is linked only where the register records the person in the company or the entry writes
 * its ЕИК; otherwise the entry may name a namesake, and it is plain text.
 */
function declaredEntry(
  i: { entity_raw: string; kind: string; timing: string },
  candidates: TiedCompany[],
  offices: ReadonlySet<string | null>,
): NonNullable<PersonDeclaration['interests']>[number] | null {
  const named = candidates.filter(
    (c) =>
      declaredTextHasEik(i.entity_raw, c.eik) ||
      c.names.some((name) => companyNamesAlike(i.entity_raw, name)),
  );
  if (new Set(named.map((c) => c.eik)).size !== 1) return null;
  const c = named[0]!;
  if (c.links.some((l) => l.status === 'suppressed')) return null;
  const counted = c.links.filter((l) => l.surfaced);
  if (counted.length) {
    const scopes = new Set(counted.map((l) => l.class));
    return {
      company: i.entity_raw,
      kind: i.kind,
      timing: i.timing,
      eik: c.eik,
      scope:
        scopes.size === 1
          ? scopes.has('family_ownership')
            ? 'family'
            : 'self'
          : ('unknown' as const),
    };
  }
  if (
    c.links.some((l) => l.class === 'ex_officio_board') ||
    (i.kind === 'management' && (c.ownershipKind != null || offices.has(c.eik)))
  )
    return null;
  const stake = i.kind === 'shares' || i.kind === 'participation';
  const status: DeclaredEntryStatus =
    i.timing === 'unknown'
      ? 'period'
      : i.kind === 'securities' ||
          (stake &&
            ((c.legalForm != null && JOINT_STOCK_FORMS.has(c.legalForm.toUpperCase())) ||
              c.links.some((l) => l.tier === 'bar_joint_stock')))
        ? 'shares'
        : c.roles.length === 0 &&
            c.links.some((l) => ['unknown', 'outside_tr', 'refuted'].includes(l.tier))
          ? 'unconfirmed'
          : 'declared';
  const classes = new Set(c.links.map((l) => l.class));
  return {
    company: i.entity_raw,
    kind: i.kind,
    timing: i.timing,
    eik: c.roles.length > 0 || declaredTextHasEik(i.entity_raw, c.eik) ? c.eik : null,
    scope:
      classes.size === 1 && classes.has('family_ownership')
        ? 'family'
        : classes.size === 1 && classes.has('private_ownership')
          ? 'self'
          : 'unknown',
    status,
    ...(c.roles.length ? { registryRoles: c.roles } : {}),
  };
}
