/**
 * Organizations whose own governing and control bodies have a category of their own in the register of
 * declarations. A member files there BECAUSE of the seat, so for that member the seat is the office the
 * declaration is filed for — a held position, as running a public enterprise is (ADR-0047 §2), not a private
 * interest. Only for the members who file in the category: for everybody else the organization is what it is,
 * and it is never public property for anyone.
 *
 * Data, not a heuristic: the category names the organization, the ЕИК is its partida. The declarations write the
 * organization in shorthand („БЧК", „НС на БЧК"), which no name match ties to a company, so the pair is listed.
 */
export const OFFICE_ORGANIZATIONS: readonly {
  categoryIncludes: string;
  eik: string;
  /** The organization as the site names it where the declaration is filed for a seat in its bodies. */
  name: string;
  /** How a declarant's own „Месторабота" names it, in any of the spellings the filings use. */
  names: RegExp;
}[] = [
  // Българският Червен кръст: „Членовете на ръководните и на контролните органи на БЧК".
  {
    categoryIncludes: 'органи на БЧК',
    eik: '000703415',
    name: 'Български Червен кръст',
    names: /БЧК|червен+\s*кр[ъа]ст/iu,
  },
];

/** The ЕИК of the organization a declaration category is the office in, or null. */
export function officeOrganizationEik(category: string | null | undefined): string | null {
  const c = String(category ?? '');
  return OFFICE_ORGANIZATIONS.find((o) => c.includes(o.categoryIncludes))?.eik ?? null;
}

/**
 * SQL: the person files in the category of the organization `eik` names, so a seat there is their office.
 * `personIds` is an SQL expression yielding the person's declaration person ids; `eik` an SQL expression.
 * The literals are this module's own constants — nothing from a request reaches the text.
 */
export function officeOrganizationSql(personIds: string, eik: string): string {
  if (!OFFICE_ORGANIZATIONS.length) return '0';
  return `(${OFFICE_ORGANIZATIONS.map(
    (o) => `(${eik}='${o.eik}' AND EXISTS (SELECT 1 FROM declarations office_d
      WHERE office_d.person_id IN (${personIds}) AND instr(office_d.category,'${o.categoryIncludes}')>0))`,
  ).join(' OR ')})`;
}

/** A folder of declaration TYPES — annual, entry and final — where the register lists the documents again, under
 *  no category of their own. */
const TYPE_FOLDER = /^(?:встъпителни|ежегодни)[\s,].*декларации$/iu;

/**
 * The institution a declaration is shown under when it is filed for a seat in the bodies of an organization
 * (ADR-0047 §2), and on what ground; null when it is shown as filed. Presentation only: the stored declaration —
 * its „Месторабота" (`institution`) above all — is not changed, and the caller shows it beside, as written.
 *
 * - A filing in the organization's own category is the seat's: the category names the organization. Its
 *   „Месторабота" is often the declarant's day job (a university, a hospital, a ministry, a company).
 * - A copy in a folder of declaration types has no category to say so. It is the seat's only when the person
 *   files in the organization's category AND its own „Месторабота" names the organization. The person's other
 *   offices are filed there too, and stay as they are.
 */
export function officeInstitution(
  filing: { category?: string | null; institution?: string | null },
  personCategories: readonly (string | null | undefined)[],
): { name: string; basis: 'category' | 'workplace' } | null {
  const category = String(filing.category ?? '').trim();
  const own = OFFICE_ORGANIZATIONS.find((o) => category.includes(o.categoryIncludes));
  if (own) return { name: own.name, basis: 'category' };
  if (category && !TYPE_FOLDER.test(category)) return null;
  const named = OFFICE_ORGANIZATIONS.find(
    (o) =>
      o.names.test(String(filing.institution ?? '')) &&
      personCategories.some((c) => String(c ?? '').includes(o.categoryIncludes)),
  );
  return named ? { name: named.name, basis: 'workplace' } : null;
}
