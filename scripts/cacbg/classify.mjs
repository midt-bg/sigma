// Pure classification helpers for the hardened matcher. Each is deterministic; the ONE heuristic
// (name distinctiveness) is conservative — it only ever *withholds* a match, never fabricates one.

// Legal-form abbreviations, matched as WHOLE tokens (not a boundary regex). companyNameKey keeps
// punctuation (commas, periods, quotes, hyphens — e.g. „X ООД, гр.Y", the standard registry form), and a
// boundary/lookaround regex can't cover every punctuation neighbour: any it misses leaves the form token
// counted as a content word → inflated distinctiveness → premature B_distinctive publish. Splitting on
// non-letter runs and dropping form tokens by exact membership is immune to whatever punctuation abuts them.
const FORM_TOKENS = new Set([
  'ЕООД',
  'ЕАД',
  'ООД',
  'АД',
  'ЕТ',
  'ДЗЗД',
  'КД',
  'СД',
  'АДСИЦ',
  'КДА',
  'КООПЕРАЦИЯ',
  'ФОНДАЦИЯ',
  'СДРУЖЕНИЕ',
]);

// A седалище/seat declarants sometimes append to a company cell („X АД, гр. София" / „X ООД гр.Русе").
// The фирма proper ends at the legal form (ЗТРРЮЛНЦ), so a trailing seat is NOT part of the name — but if
// it slips through it defeats closelyHeldForm's end-anchored form test (an АД read as closely-held → the
// „11 акции на Trace → €88M" libel trap) and inflates nameDistinctiveness (a seat token counted as a
// content word → premature B_distinctive publish). Strip it before either test. Fail-SAFE by construction:
// only a comma-led tail bearing NO legal-form token (a form-bearing tail IS the фирма — kept) or an explicit
// settlement marker („гр./с./общ./обл./ж.к.") is removed, so „АД ГРУП ООД", „ТОПЛОФИКАЦИЯ СОФИЯ ЕАД" and
// „АД-ХОК ЕООД" are untouched; any over-strip only ever REMOVES a distinguishing token (pushing toward
// generic/withhold — the safe side), never fabricates a joint-stock exclusion. Operates on UPPERCASE input.
const SEAT_MARKER = /\s+(?:ГР|С|ОБЩ|ОБЛ|Ж\.К)\.\s*\S[^,]*$/u;
const hasFormToken = (s) => s.split(/[^А-ЯЁ]+/).some((t) => FORM_TOKENS.has(t));

// The legal forms that TERMINATE a фирма (ЗТРРЮЛНЦ writes them as a suffix), so anything after one is a
// seat or a qualifier — never part of the name. ЕТ/СД/КД/КООПЕРАЦИЯ/ФОНДАЦИЯ/СДРУЖЕНИЕ are deliberately
// ABSENT: those PRECEDE the фирма („ЕТ Алекс Петров Димитров"), and truncating after them would eat the
// name itself — turning a distinctive ЕТ into a generic one and withholding a true link.
const SUFFIX_FORMS = new Set(['ЕООД', 'ООД', 'ЕАД', 'АД', 'АДСИЦ', 'КДА', 'ДЗЗД']);

// Cut everything after the LAST фирма-terminating form token. This is the case the comma-peel and the
// marker strip both miss: „ТРЕЙС ГРУП ХОЛД АД София" has neither a comma nor a „гр." dot, so it survived
// both, stopped ending in its form, and defeated every end-anchored form test downstream. Token-exact
// (never a substring), so „КАДИЕВ ГЛОБАЛ ЕООД" and „АД-ХОК ЕООД" are untouched.
function stripAfterSuffixForm(s) {
  const re = /[А-ЯЁ]+/gu;
  let last = null;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) if (SUFFIX_FORMS.has(m[0])) last = m;
  return last === null ? s : s.slice(0, last.index + last[0].length).trim();
}

function stripSeatSuffix(upper) {
  let s = String(upper).trim();
  // Peel trailing comma-clauses right-to-left while the clause bears no legal form (i.e. it's a seat, not
  // the фирма tail). Comma-peel runs BEFORE the marker strip so „X АД, гр. София" loses the whole „, …"
  // clause (no dangling comma left to break the terminal form anchor).
  for (
    let m = s.match(/^(.*),\s*([^,]+)$/u);
    m && !hasFormToken(m[2]);
    m = s.match(/^(.*),\s*([^,]+)$/u)
  ) {
    s = m[1].trim();
  }
  return stripAfterSuffixForm(s.replace(SEAT_MARKER, '').trim());
}

/**
 * Distinctiveness of a company name-key — a DISCLOSED heuristic used only to decide whether a
 * single-winner-ЕИК match is safe to auto-publish or must wait for a TR global-uniqueness census.
 * Conservative: numbers / Latin-or-brand tokens / ≥3 content words ⇒ 'distinctive' (collision-improbable);
 * a bare 1–2-word Cyrillic core (e.g. „В И К", „ДОМИНО") ⇒ 'generic' (route to census — never auto-publish).
 * @returns {'distinctive'|'generic'}
 */
export function nameDistinctiveness(key) {
  const upper = stripSeatSuffix(String(key).toUpperCase());
  if (/[0-9]/.test(upper)) return 'distinctive'; // ordinals / registration numbers
  if (/[A-Z]/.test(upper)) return 'distinctive'; // Latin / brand token
  // Split on any run of non-Cyrillic-letter chars → whole tokens; drop 1-char tokens and legal-form
  // abbreviations; the remaining content words decide. Punctuation-agnostic (see FORM_TOKENS note).
  const tokens = upper.split(/[^А-ЯЁ]+/).filter((t) => t.length > 1 && !FORM_TOKENS.has(t));
  return tokens.length >= 3 ? 'distinctive' : 'generic';
}

const norm = (s) =>
  String(s ?? '')
    .normalize('NFC')
    .toUpperCase()
    .replace(/[\s.\-–—]+/g, ' ')
    .trim();

// Joint-stock / share-issuing legal form (АД / ЕАД / АДСИЦ / КДА) as the TRAILING form token. In BG company names the
// legal form is always the suffix, so anchor to the end (optionally followed by quotes/whitespace); a whole
// token bounded on the left by string edge, whitespace or quotes — NOT hyphens/dots, so „АД-ХОК ЕООД" (a
// hyphenated ООД name) is not misread. Anchoring to the suffix is what stops „АД ГРУП ООД" (an ООД whose
// NAME begins with the token „АД") being wrongly excluded as joint-stock — the form there is ООД.
// Twinned byte-for-byte by JOINT_SUFFIX in scripts/tr/deed.mjs — the TR parser cannot import from this
// directory without closing a cacbg↔tr cycle. A test in deed.test.mjs pins the two identical; change one
// and that test fails rather than the two silently diverging on a legal form.
export const JOINT_STOCK = /(?:^|[\s"„“”«»])(АД|ЕАД|АДСИЦ|КДА)[\s"„“”«»]*$/u;
// The same four forms as whole tokens. Kept in step with JOINT_STOCK above by classify.test.mjs, and with
// deed.mjs's JOINT_SUFFIX twin by deed.test.mjs — three spellings of one rule, all three pinned.
const JOINT_STOCK_FORMS = new Set(['АД', 'ЕАД', 'АДСИЦ', 'КДА']);
/**
 * Materiality by legal form. The public ownership surface is CLOSELY-HELD companies only (ООД/ЕООД/ЕТ/
 * КД/СД/ДЗЗД or a form-unspecified name from the closely-held table). Joint-stock forms (АД/ЕАД/АДСИЦ/КДА,
 * the last a командитно дружество с акции — it issues shares, so it belongs with them) are
 * public-float securities — a declared parcel of listed shares is NOT a material ownership conflict, and
 * presenting it as one defames (the „11 Trace shares → €88M" trap). Excludes only an explicit АД-form token,
 * so it withholds rather than fabricates. @returns {boolean} true ⇒ material/closely-held.
 */
export function closelyHeldForm(name) {
  // LAST-FORM-TOKEN-WINS, not an end anchor. The anchor asked „does the name END in a joint-stock form?",
  // which a declarant-typed cell can defeat just by appending a seat — and `stripSeatSuffix` cannot be
  // trusted to have removed every shape of one. Asking instead „which legal form is the name's LAST?"
  // is position-independent: a trailing seat, a stray qualifier, or nothing at all leaves the verdict
  // unchanged, while „АД" leading („АД ГРУП ООД") or glued („АД-ХОК ЕООД") still isn't the form.
  //
  // This is why the predicate no longer uses JOINT_STOCK directly while deed.mjs's twin still does: that
  // twin reads the deed envelope's `fullName` — a REGISTRY-clean name that genuinely ends in its form —
  // whereas this one reads a free-text cell a human typed. Same rule, different input hygiene.
  const tokens = stripSeatSuffix(
    String(name ?? '')
      .normalize('NFC')
      .toUpperCase(),
  )
    .split(/[^А-ЯЁ]+/u)
    .filter(Boolean);
  const lastForm = tokens.filter((t) => FORM_TOKENS.has(t)).at(-1);
  // No form token at all ⇒ nothing says joint-stock ⇒ material, exactly as the anchor behaved. The bar
  // only ever fires on an EXPLICIT joint-stock form, so it withholds rather than fabricates.
  return lastForm === undefined || !JOINT_STOCK_FORMS.has(lastForm);
}

// seatConfirmed() and publishTier() lived here until #279. The publish tiers they produced
// (A_seat / B_distinctive / C_hold) are superseded by the Trade Register evidence ladder in
// scripts/tr/evidence.mjs — identity now rests on a checkable registry fact rather than on the shape
// of the declared name (ADR-0033, superseding ADR-0009). The seat comparison moved with it, because a
// declared seat is now matched against the REGISTERED seat rather than against the winner row's
// settlement column. nameDistinctiveness above survives, narrowed to an AND-gate on the weakest rung.

/**
 * Temporal relation of a contract to the years a stake was declared (asset decls are annual snapshots).
 * Deterministic from years alone.
 *   'contemporaneous'   — contract year within [minDecl, maxDecl] (stake provably held then).
 *   'after_last_decl'   — contract after the last declaration (stake may have been sold — do not claim current).
 *   'before_first_decl' — contract before the first declaration (stake may not yet have existed).
 *   'unknown'           — missing years.
 * @param {number[]} declYears  @param {number} contractYear
 */
export function temporalStatus(declYears, contractYear) {
  const ys = declYears.filter((y) => Number.isFinite(y));
  if (!ys.length || !Number.isFinite(contractYear)) return 'unknown';
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  if (contractYear < min) return 'before_first_decl';
  if (contractYear > max) return 'after_last_decl';
  return 'contemporaneous';
}

/**
 * Locality token of a public body, for the DISCLOSED same-region heuristic (institution↔authority).
 * „Област - Русе" / „Община Русе" → „РУСЕ"; ministries and national bodies → null (no locality).
 */
export function localityToken(institution) {
  const m = String(institution ?? '').match(/(?:Област|Община|Район)\s*[-–—]?\s*([А-Яа-яЁё]+)/);
  return m ? norm(m[1]) : null;
}
