// Which institution a declaration is filed FOR, when its own „Месторабота" is the declarant's day job.
//
// ADR-0040 lets the declaration decide its institution: `<Work>` is what the person signed, the register's
// listing only arranges the documents. That holds for an employee of a ministry or a municipality. It fails
// for the officials who declare because of a SEAT — a member of the board of a public enterprise, a
// municipal councillor — and hold a job elsewhere: their `<Work>` names a private company, and the site
// then showed that company as the office held, next to the state enterprise's own listing of the same
// person. The seat is the reason to declare; the day job is not an office.
//
// The correction is deliberately narrow, because the wrong direction is worse: erasing a real office. A
// filing is re-homed only when BOTH hold — its institution is a company the corpus knows to be private
// (a procurement winner without public ownership, or a registry partida with no public owner), AND the
// same declarant (the register's own GUID) filed within a year under an institution that is not such a
// company. The same year wins over the neighbouring one; nothing else is touched, and a declarant with no
// such filing keeps the day job as before.

/** Parse the declared year as a number, or null when the record has none. */
const yearOf = (rec) => {
  const y = Number.parseInt(String(rec.year ?? ''), 10);
  return Number.isInteger(y) ? y : null;
};

/**
 * @param {Array<{xmlFile:string, year?:string|number|null}>} filings every filing record
 * @param {{
 *   institutionOf: (rec: object) => string,
 *   sourceId: (rec: object) => string,
 *   guidOf: (xmlFile: string) => string|null,
 *   isPrivateCompany: (institution: string) => boolean,
 * }} by how to read a record
 * @returns {Map<string, string>} source id → the institution carried from the declarant's other filing
 */
export function resolveOffices(filings, { institutionOf, sourceId, guidOf, isPrivateCompany }) {
  // The filings that can lend an office: per declarant, those whose institution is not a private company.
  const lenders = new Map();
  for (const rec of filings) {
    const guid = guidOf(rec.xmlFile);
    const institution = institutionOf(rec);
    if (!guid || !institution || isPrivateCompany(institution)) continue;
    const list = lenders.get(guid) ?? [];
    list.push({ year: yearOf(rec), institution });
    lenders.set(guid, list);
  }
  const offices = new Map();
  for (const rec of filings) {
    const institution = institutionOf(rec);
    if (!institution || !isPrivateCompany(institution)) continue;
    const guid = guidOf(rec.xmlFile);
    const year = yearOf(rec);
    if (!guid || year === null) continue;
    const near = (lenders.get(guid) ?? [])
      .filter((l) => l.year !== null && Math.abs(l.year - year) <= 1)
      .sort((a, b) => Math.abs(a.year - year) - Math.abs(b.year - year) || a.year - b.year);
    if (near.length) offices.set(sourceId(rec), near[0].institution);
  }
  return offices;
}
