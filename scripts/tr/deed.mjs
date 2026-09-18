// The registry facts of one company, as the evidence ladder reads them (issue #279, ADR-0033, ADR-0041).
// Pure: rows in, facts out. No I/O, no network, no state.
//
// The facts come from the registry layer the daily ETL keeps in D1 (ADR-0041): `registry_deeds` — the legal
// form, the settlement of the seat and the day it was registered, the day of the ownership record — and
// `registry_roles` — who holds which role, from which entry, until when. The decision pass reads them from
// the work DB the job exports them into; nothing here, or anywhere in this leg, asks the register itself.
//
// Each holder is its own row, so a declarant's name is matched against ONE registered person at a time by
// construction. That was the libel guard the HTML-era parser had to enforce by splitting a field into its
// entities before matching — one person's given name combined with another's surname is a named public
// claim about the wrong human being. Here there is nothing to split, and nothing to combine.

import { OWNERSHIP_FIELDS, MANAGER_FIELD } from '../../packages/ingest/src/registry-roles.ts';

/** The manager field, then the ownership fields — the roles the ladder reads. */
export const ROLE_FIELDS = [MANAGER_FIELD, ...OWNERSHIP_FIELDS];
export { OWNERSHIP_FIELDS, MANAGER_FIELD };

const isoDay = (v) => (v ? String(v).slice(0, 10) : null);

/**
 * The facts of one company from its rows in the registry layer.
 *
 * Only a natural person who STANDS in a role the ladder reads becomes a holder: an ended role is not who
 * is registered now, a company is not a declarant, and a field the ladder does not read is not evidence.
 * Those three are dropped here and nowhere else, so the rule for „registered now" is auditable in one place.
 *
 * @param {{eik:string, name?:string|null, legal_form?:string|null, seat_settlement?:string|null,
 *          seat_entry_on?:string|null, owners_entry_on?:string|null}} deed  the `registry_deeds` row
 * @param {{field_ident:string, subject_kind?:string, subject_name:string, entry_number?:string|null,
 *          added_on?:string|null, removed_on?:string|null}[]} roles  its `registry_roles` rows
 */
export function registryFacts(deed, roles) {
  const read = new Set(ROLE_FIELDS);
  const holders = roles
    .filter(
      (r) =>
        read.has(r.field_ident) &&
        r.subject_kind !== 'entity' &&
        r.removed_on == null &&
        !r.uncertain_after,
    )
    .map((r) => ({
      field: String(r.field_ident),
      name: String(r.subject_name ?? ''),
      ...(r.subject_id ? { subjectId: r.subject_id } : {}),
      // TEXT, never a number: an entry number like 20130716101007 exceeds 2^53 once combined.
      entryNumber: r.entry_number == null ? null : String(r.entry_number),
      entryDate: isoDay(r.added_on),
    }))
    // A total order, so which of two holders a name meets first never depends on how the rows arrived.
    .sort(
      (a, b) =>
        a.field.localeCompare(b.field) ||
        String(a.entryDate).localeCompare(String(b.entryDate)) ||
        a.name.localeCompare(b.name),
    );
  // Roles not standing now — ended, or of an end the register leaves unclear (`endedOn` null). They show
  // who was in the company, and must never answer the independent question of who is registered now.
  const endedHolders = roles
    .filter(
      (r) =>
        read.has(r.field_ident) &&
        r.subject_kind === 'person' &&
        (r.removed_on != null || r.uncertain_after),
    )
    .map((r) => ({
      field: String(r.field_ident),
      name: String(r.subject_name ?? ''),
      ...(r.subject_id ? { subjectId: r.subject_id } : {}),
      entryNumber: r.entry_number == null ? null : String(r.entry_number),
      entryDate: isoDay(r.added_on),
      endedOn: isoDay(r.removed_on),
    }))
    .sort(
      (a, b) =>
        a.field.localeCompare(b.field) ||
        String(a.entryDate).localeCompare(String(b.entryDate)) ||
        a.name.localeCompare(b.name),
    );
  return {
    uic: String(deed.eik),
    name: deed.name ?? null,
    legalForm: deed.legal_form ?? null,
    seat: { settlement: deed.seat_settlement ?? '', entryDate: isoDay(deed.seat_entry_on) },
    ownersEntryDate: isoDay(deed.owners_entry_on),
    holders,
    endedHolders,
  };
}

/**
 * The standing holders of the requested fields — the single entry point to who is registered now.
 * @returns {{field:string, name:string, entryNumber:string|null, entryDate:string|null}[]}
 */
export function liveHolders(facts, fields) {
  const want = new Set(fields);
  return (facts?.holders ?? []).filter((h) => want.has(h.field));
}

// ── names ─────────────────────────────────────────────────────────────────────
/**
 * Name tokens: NFC, upper case, split on non-letters, keep tokens of length ≥2.
 *
 * Dropping 1-character tokens is what makes „Г. И. Петров" a ONE-token name rather than a three-token
 * one — an abbreviated name can then never reach the ≥3 tokens rung 2 requires, instead of passing on
 * initials that match half the register. Latin letters are kept (never folded onto Cyrillic
 * look-alikes) so a homoglyph is a non-match rather than a false match, matching companyNameKey's
 * posture in packages/shared/src/company-name-key.ts.
 *
 * A near-twin of the module-private `holderTokens` in scripts/cacbg/parse.mjs — deliberately
 * re-implemented rather than imported, because that module pulls in fast-xml-parser and would tie
 * these pure tests to a workspace install. Keep the two in step.
 */
export function personTokens(name) {
  return String(name ?? '')
    .normalize('NFC')
    .toUpperCase()
    .split(/[^\p{L}]+/u)
    .filter((t) => [...t].length >= 2);
}

/**
 * Does EVERY token of the declarant's name appear as a whole token of this ONE holder's name?
 *
 * Full subset, not a majority: of 301 measured matches, 46 were two-token only, which is precisely
 * the homonym risk. Whole-token, not substring: „ПЕТРОВ" inside „ПЕТРОВА" is a different person.
 */
export function fullSubsetMatch(declarantName, holderName) {
  const want = personTokens(declarantName);
  if (want.length === 0) return false;
  const have = new Set(personTokens(holderName));
  return want.every((t) => have.has(t));
}

// ── seat ──────────────────────────────────────────────────────────────────────
// Strip a settlement-type prefix only as a WHOLE token: „гр."/„с."/„общ."/„обл."/„ж.к." followed by a
// dot and optional space. R9 — a loose prefix strip turns СОФИЯ into ОФИЯ and ГРАДЕЦ into АДЕЦ.
const SETTLEMENT_PREFIX = /^(?:ГР|С|ОБЩ|ОБЛ|Ж\.К)\.\s*/u;

/** Normalise a settlement name for comparison. Empty in ⇒ empty out, and empty NEVER confirms. */
export function normalizeSettlement(raw) {
  let s = String(raw ?? '')
    .normalize('NFC')
    .toUpperCase()
    .replace(/\([^)]*\)/g, ' ') // „(столица)"
    .trim();
  s = s.split(/[,/]/)[0].trim(); // cut at the first comma or slash — „с. Марково, п.к. 4108"
  s = s.replace(SETTLEMENT_PREFIX, '');
  return s
    .replace(/[^\p{L}\s-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The company's registered settlement and the day of the entry that registered the seat as it stands.
 *
 * ADR-0010 item 3 (addresses are never extracted) holds upstream: the registry layer keeps the settlement
 * of the seat and nothing else of the address, so there is nothing else here to leave out.
 * @returns {{settlement:string, entryDate:string|null}}
 */
export function registrySeat(facts) {
  return {
    settlement: normalizeSettlement(facts?.seat?.settlement ?? ''),
    entryDate: facts?.seat?.entryDate ?? null,
  };
}

// ── legal form ────────────────────────────────────────────────────────────────
// The register's own code for the legal form, as its API gives it — measured on the register's API
// 2026-09-11: AD, EAD, OOD, EOOD, ET, K. DELIBERATELY incomplete: a code absent here is `unknown` and
// WITHHOLDS, because assuming a form is closely held is exactly the fail-open this bar exists to prevent.
const FORM_CODES = new Map([
  ['ET', 'closely_held'], // ЕТ
  ['OOD', 'closely_held'], // ООД
  ['EOOD', 'closely_held'], // ЕООД
  ['KD', 'closely_held'], // КД
  ['SD', 'closely_held'], // СД
  ['K', 'closely_held'], // кооперация
  ['AD', 'joint_stock'], // АД
  ['EAD', 'joint_stock'], // ЕАД
  ['KDA', 'joint_stock'], // КДА
  ['ADSITS', 'joint_stock'], // АДСИЦ
]);

// The фирма's legal form is also its SUFFIX under ЗТРРЮЛНЦ, so the bar has a second, independent signal
// wherever the name carries one.
//
// DELIBERATELY a twin of classify.mjs's JOINT_STOCK rather than an import, for the same reason
// personTokens twins parse.mjs's holderTokens: the dependency direction here is cacbg → tr (load.mjs
// imports this module), so importing back out of scripts/cacbg/ would close a cycle across the two
// directories. The two are pinned byte-identical by a test in deed.test.mjs.
export const JOINT_SUFFIX = /(?:^|[\s"„“”«»])(АД|ЕАД|АДСИЦ|КДА)[\s"„“”«»]*$/u;
const CLOSELY_SUFFIX = /(?:^|[\s"„“”«»])(ООД|ЕООД|ЕТ|ДЗЗД|КД|СД|КООПЕРАЦИЯ)[\s"„“”«»]*$/u;

/**
 * Legal-form verdict — a union of the register's code and the mandated фирма suffix.
 * Either signal saying joint-stock bars the link. Neither able to say ⇒ `unknown`, which withholds.
 * @returns {{code:string|null, codeVerdict:string, suffixVerdict:string, verdict:string}}
 */
export function registryLegalForm(facts) {
  const code = facts?.legalForm ? String(facts.legalForm).trim().toUpperCase() : null;
  const codeVerdict = (code != null && FORM_CODES.get(code)) || 'unknown';

  const name = String(facts?.name ?? '')
    .normalize('NFC')
    .toUpperCase()
    .trim();
  const suffixVerdict = JOINT_SUFFIX.test(name)
    ? 'joint_stock'
    : CLOSELY_SUFFIX.test(name)
      ? 'closely_held'
      : 'unknown';

  const verdict =
    codeVerdict === 'joint_stock' || suffixVerdict === 'joint_stock'
      ? 'joint_stock'
      : codeVerdict === 'closely_held' || suffixVerdict === 'closely_held'
        ? 'closely_held'
        : 'unknown';
  return { code, codeVerdict, suffixVerdict, verdict };
}

// ── refutation input ──────────────────────────────────────────────────────────
/**
 * The day of the latest entry across the ownership fields that stand, or null when none stands.
 *
 * An erased ownership field is not in it: the registry layer dates the record by the fields whose last
 * entry still stands, so an erasure cannot become „the latest ownership entry" and refute a link it
 * says nothing about.
 */
export function latestOwnershipEntryDate(facts) {
  return facts?.ownersEntryDate ?? null;
}
