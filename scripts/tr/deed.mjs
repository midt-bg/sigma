// Pure parser for a Търговски регистър deed (issue #279, ADR-0033). No I/O, no network, no state.
//
// The envelope is clean JSON, but every field's VALUE is an HTML fragment with semi-structured
// Bulgarian inside. That inner parser is where the libel risk lives, so the order of operations below
// is an invariant with tests on it, not a suggestion:
//
//   decode HTML entities
//     → split into entities on record-container / hr--report
//     → drop entities marked erased
//     → strip tags WITHIN one entity
//     → separate the name from the address/stake WITHIN that entity
//     → match tokens ONLY within a single entity
//
// Any other order silently merges blocks. Field CR_F_19_L routinely holds several съдружници in one
// string; matching a declarant against the whole field lets one person's given name combine with
// another's surname, and the output is a named public claim about the wrong human being.

const OWNERSHIP_FIELDS = ['CR_F_18_L', 'CR_F_19_L', 'CR_F_23_L'];
const MANAGER_FIELD = 'CR_F_7_L';
export const ROLE_FIELDS = [MANAGER_FIELD, ...OWNERSHIP_FIELDS];
export { OWNERSHIP_FIELDS, MANAGER_FIELD };

// ── html ──────────────────────────────────────────────────────────────────────
const ENTITIES = {
  '&quot;': '"',
  '&apos;': "'",
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
};
// `String.fromCodePoint` THROWS RangeError above U+10FFFF (and on a surrogate half), and the input is
// whatever the register put on the wire. An unguarded throw here does not stay local: it escapes
// entityBlocks and registrySeat, past the crawl loop's refuse-and-continue block (which covers only
// JSON.parse + assertUicEcho) and out of run() — one malformed escape in one deed ends a paced crawl
// that has already spent its request budget, and does the same to load.mjs at decision time.
// Out of range is not a character and cannot be part of a name, so it decodes to nothing: the rest of
// the entity still parses, which is the difference between losing a glyph and losing the run.
const MAX_CODE_POINT = 0x10ffff;
const codePoint = (n) =>
  Number.isInteger(n) && n >= 0 && n <= MAX_CODE_POINT ? String.fromCodePoint(n) : '';

/** Decode the entity set the register actually emits, plus numeric escapes. FIRST step, always. */
function decodeEntities(s) {
  return String(s)
    .replace(/&(?:quot|apos|amp|lt|gt|nbsp);/g, (m) => ENTITIES[m])
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => codePoint(parseInt(n, 16)));
}

/** Strip tags and collapse whitespace, INSIDE one already-isolated entity. */
function stripTags(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// An entity is erased when the register says so. MEASURED on a live deed: the marker is
// `erasure-text-inline` (with `ui-icon-erased`) and the container carries no `field-text` paragraph at
// all. `field-text--erased` is accepted as well — it is the other spelling reported for this register,
// and honouring both costs nothing while assuming one costs a wrong publish.
const ERASED_MARKER = /erasure-text-inline|ui-icon-erased|field-text--erased/;

// The erasure notice, stripped so „Заличено обстоятелство." never reads as content.
//
// The `{0,2000}` bound is not cosmetic. With a plain `.*?` this backtracks QUADRATICALLY on markup where
// the opening div is never closed: every opening restarts a scan to end-of-input, measured at 34K→3.3ms,
// 68K→13.6ms, 136K→53.8ms, 272K→240ms, 1M→4.0s — ×4 per doubling. Bounding the lazy run makes each start
// position scan a fixed window instead, which is linear: the same inputs measure 5.3 / 10.3 / 24.8 / 41.6
// / 187ms. A real notice is one short sentence, so 2000 characters is ~80× the live shape.
//
// Failing to match is safe by construction: `erased` is decided independently by ERASED_MARKER above, so
// an over-long notice still marks the block erased and liveFields still drops it. The only visible effect
// is that its text survives into the block — which in strict mode raises the drift alarm, loudly, rather
// than passing anything through silently.
const ERASURE_NOTICE =
  /<div[^>]*class=['"][^'"]*erasure-text-inline[^'"]*['"][^>]*>.{0,2000}?<\/div>/gis;

/**
 * Split one field's htmlData into the separate registered entities it holds.
 *
 * @param {string} html
 * @param {{strict?:boolean}} [opts] `strict` turns the erased-with-content contradiction into a throw.
 * @returns {{text:string, erased:boolean}[]}
 */
export function entityBlocks(html, { strict = false } = {}) {
  if (html == null || String(html).trim() === '') return [];
  const decoded = decodeEntities(html); // decode BEFORE splitting — see the order above
  const chunks = decoded
    .split(/<hr\b[^>]*>/i)
    .flatMap((part) => part.split(/(?=<div[^>]*class=['"][^'"]*record-container)/i))
    .map((c) => c.trim())
    .filter((c) => c !== '');

  const out = [];
  for (const chunk of chunks) {
    const erased = ERASED_MARKER.test(chunk);
    // Read the visible text WITHOUT the erasure notice, so „Заличено обстоятелство." never counts as
    // content and an erased block reads as empty.
    const withoutNotice = chunk.replace(ERASURE_NOTICE, ' ');
    const text = stripTags(withoutNotice);
    if (erased && text !== '' && strict) {
      throw new Error(
        `REFUSE: an erased entity carries content (${JSON.stringify(text.slice(0, 60))}) — the ` +
          `"erased ⇒ empty" assumption has drifted; stop rather than guess which state is in force`,
      );
    }
    if (text === '' && !erased) continue; // structural noise, not an entity
    out.push({ text, erased });
  }
  return out;
}

/** Every field in the deed, flattened out of sections → subDeeds → groups. */
function allFields(deed) {
  const out = [];
  for (const s of deed?.sections ?? [])
    for (const sd of s?.subDeeds ?? [])
      for (const g of sd?.groups ?? []) for (const f of g?.fields ?? []) out.push(f);
  return out;
}

const isoDay = (v) => (v ? String(v).slice(0, 10) : null);

/**
 * The LIVE entities of the requested field codes — the single entry point to live state.
 * Erased entities are dropped here and nowhere else, so the rule is auditable in one place.
 * @returns {{nameCode:string, entryDate:string|null, entryNumber:string|null, entities:string[]}[]}
 */
export function liveFields(deed, nameCodes, opts = {}) {
  const want = new Set(nameCodes);
  const out = [];
  for (const f of allFields(deed)) {
    if (!want.has(f.nameCode)) continue;
    const entities = entityBlocks(f.htmlData, opts)
      .filter((b) => !b.erased)
      .map((b) => b.text);
    if (entities.length === 0) continue;
    out.push({
      nameCode: f.nameCode,
      // TEXT, never a number: a fieldEntryNumber like 20130716101007 exceeds 2^53 once combined.
      entryNumber: f.fieldEntryNumber == null ? null : String(f.fieldEntryNumber),
      entryDate: isoDay(f.fieldEntryDate),
      entities,
    });
  }
  return out;
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
 * Does EVERY token of the declarant's name appear as a whole token of this ONE entity?
 *
 * Full subset, not a majority: of 301 measured matches, 46 were two-token only, which is precisely
 * the homonym risk. Whole-token, not substring: „ПЕТРОВ" inside „ПЕТРОВА" is a different person.
 *
 * Callers MUST pass a single entity's text (see entityBlocks). Passing a whole field is the
 * cross-entity bug, and no signature can prevent it — the test does.
 */
export function fullSubsetMatch(declarantName, entityText) {
  const want = personTokens(declarantName);
  if (want.length === 0) return false;
  const have = new Set(personTokens(entityText));
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
 * The company's registered settlement, from CR_F_5_L's „Населено място:" segment ONLY.
 *
 * ADR-0010 item 3 (addresses are never extracted) is honoured here, and the field makes that a live
 * concern rather than a formality: CR_F_5_L also carries street, postcode, phone, fax, e-mail and
 * website. Nothing but the settlement and the entry date leaves this function.
 * @returns {{settlement:string, entryDate:string|null}}
 */
export function registrySeat(deed) {
  for (const f of liveFields(deed, ['CR_F_5_L'])) {
    for (const text of f.entities) {
      const m = text.match(/Населено място:\s*([^,]+)/u);
      if (m) return { settlement: normalizeSettlement(m[1]), entryDate: f.entryDate };
    }
  }
  return { settlement: '', entryDate: null };
}

// ── legal form ────────────────────────────────────────────────────────────────
// Codes observed empirically (#279 §3 + the spike's catalogue read). DELIBERATELY incomplete: the
// nomenclature endpoint does not settle the enum (legalForm=4 and =10 return a byte-identical
// catalogue), so anything absent here is `unknown` and WITHHOLDS. In particular whether ЕАД carries
// its own code is unresolved — ООД and ЕООД turned out NOT to share one (4 vs 10), so assuming ЕАД
// shares 5 with АД would be exactly the fail-open this bar exists to prevent.
const FORM_CODES = new Map([
  [1, 'closely_held'], // ЕТ
  [4, 'closely_held'], // ООД
  [5, 'joint_stock'], // АД
  [6, 'joint_stock'], // КДА
  [10, 'closely_held'], // ЕООД
]);

// The фирма's legal form is its SUFFIX under ЗТРРЮЛНЦ, and the deed envelope's `fullName` carries it
// („ПИМК" ООД) while CR_F_2_L is bare („ПИМК"). So the bar has a second, independent signal at zero
// extra cost.
//
// DELIBERATELY a twin of classify.mjs's JOINT_STOCK rather than an import, for the same reason
// personTokens twins parse.mjs's holderTokens: the dependency direction here is cacbg → tr (load.mjs
// imports this module), so importing back out of scripts/cacbg/ would close a cycle across the two
// directories. The two are pinned byte-identical by a test in deed.test.mjs — this comment used to
// claim КДА was missing from classify.mjs, which stopped being true in 5f64f5c, and an unenforced
// „keep these in step" note is exactly how that happens.
export const JOINT_SUFFIX = /(?:^|[\s"„“”«»])(АД|ЕАД|АДСИЦ|КДА)[\s"„“”«»]*$/u;
const CLOSELY_SUFFIX = /(?:^|[\s"„“”«»])(ООД|ЕООД|ЕТ|ДЗЗД|КД|СД|КООПЕРАЦИЯ)[\s"„“”«»]*$/u;

/**
 * Legal-form verdict — a union of the numeric code and the mandated фирма suffix.
 * Either signal saying joint-stock bars the link. Neither able to say ⇒ `unknown`, which withholds.
 * @returns {{code:number|null, codeVerdict:string, suffixVerdict:string, verdict:string}}
 */
export function registryLegalForm(deed) {
  const code = typeof deed?.legalForm === 'number' ? deed.legalForm : null;
  const codeVerdict = (code != null && FORM_CODES.get(code)) || 'unknown';

  const name = String(deed?.fullName ?? '')
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
 * Latest entry date across the LIVE ownership fields, or null when none survives.
 *
 * The trap this avoids was present in the first company sampled: CR_F_23_L sits in the CURRENT deed
 * dated 2013-07-16 carrying only „Заличено обстоятелство.". Counted naively it becomes the latest
 * ownership entry and can refute a link it says nothing about. liveFields drops it.
 */
export function latestOwnershipEntryDate(deed) {
  const dates = liveFields(deed, OWNERSHIP_FIELDS)
    .map((f) => f.entryDate)
    .filter(Boolean);
  return dates.length ? dates.sort().at(-1) : null;
}

/**
 * The deed we got back must be the deed we asked for.
 *
 * R8: Bulgarian public bodies carry ЕИК of exactly the `000…` shape, so any numeric round-trip on the
 * path silently rewrites the identifier. Without this rail, that failure publishes a claim about a
 * different company under the right official's name.
 */
export function assertUicEcho(deed, requestedEik) {
  const got = deed?.uic == null ? null : String(deed.uic);
  if (got !== String(requestedEik)) {
    throw new Error(
      `REFUSE: deed uic echo mismatch — requested ${JSON.stringify(String(requestedEik))}, ` +
        `deed reports ${JSON.stringify(got)}`,
    );
  }
  return deed;
}
