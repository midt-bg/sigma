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
export const OFFICE_ORGANIZATIONS: readonly { categoryIncludes: string; eik: string }[] = [
  // Българският Червен кръст: „Членовете на ръководните и на контролните органи на БЧК".
  { categoryIncludes: 'органи на БЧК', eik: '000703415' },
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
