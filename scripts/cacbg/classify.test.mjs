import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nameDistinctiveness,
  temporalStatus,
  localityToken,
  closelyHeldForm,
  JOINT_STOCK,
} from './classify.mjs';

test('nameDistinctiveness: numbers / Latin / ≥3 words are distinctive; bare 1-2 word Cyrillic is generic', () => {
  assert.equal(nameDistinctiveness('СТЕЛИТ 1 ЕООД'), 'distinctive'); // number
  assert.equal(nameDistinctiveness('HALEON'), 'distinctive'); // Latin
  assert.equal(nameDistinctiveness('ПЪТНО СТРОИТЕЛСТВО ПЛОВДИВ АД'), 'distinctive'); // 3 content words + form
  assert.equal(nameDistinctiveness('ХИДРО СТРОЙ МОНТАЖ ЕООД'), 'distinctive'); // 3 content words + form
  assert.equal(nameDistinctiveness('В И К ООД'), 'generic'); // 1 core word after forms
  assert.equal(nameDistinctiveness('ДОМИНО ЕООД'), 'generic'); // single common word
  // The Cyrillic legal form MUST be stripped before counting content words. A 2-content-word closely-held
  // name is generic → route to census, never auto-publish. Pre-fix the ASCII-only \b in FORM never matched
  // a Cyrillic boundary, so the form token survived, inflated the count to 3, and mis-published these as
  // B_distinctive — the exact premature-publish/libel hazard the tiering exists to prevent.
  assert.equal(nameDistinctiveness('СТРОЙ ИНВЕСТ ЕООД'), 'generic'); // 2 content words + form → withhold
  assert.equal(nameDistinctiveness('НИКАС КОМЕРС ООД'), 'generic'); // 2 content words + form → withhold
  assert.equal(nameDistinctiveness('ВОДОСНАБДЯВАНЕ И КАНАЛИЗАЦИЯ ЕООД'), 'generic'); // 2 content words (И dropped)
  // companyNameKey keeps punctuation, so the form token must be dropped regardless of an abutting comma /
  // period / hyphen / quote — the standard registry forms „X ООД, гр.Y" / „X.ИНВЕСТ-ЕООД". A boundary regex
  // missed these and mis-published them as B_distinctive.
  assert.equal(nameDistinctiveness('ИНВЕСТ ООД, СОФИЯ'), 'generic'); // comma after form; ИНВЕСТ+СОФИЯ = 2
  assert.equal(nameDistinctiveness('СТРОЙ ИНВЕСТ, ЕООД'), 'generic'); // comma before form; СТРОЙ+ИНВЕСТ = 2
  assert.equal(nameDistinctiveness('СТРОЙ.ИНВЕСТ-ЕООД'), 'generic'); // period+hyphen glued; still 2 content words
  assert.equal(nameDistinctiveness('„ДОМИНО" ЕООД'), 'generic'); // quoted single word + form
});

test('temporalStatus: contract within declared-year span is contemporaneous', () => {
  assert.equal(temporalStatus([2020, 2021, 2022], 2021), 'contemporaneous');
  assert.equal(temporalStatus([2020, 2022], 2024), 'after_last_decl');
  assert.equal(temporalStatus([2022, 2023], 2019), 'before_first_decl');
  assert.equal(temporalStatus([], 2021), 'unknown');
  assert.equal(temporalStatus([2021], NaN), 'unknown');
});

test('closelyHeldForm: ООД/ЕООД/ЕТ material; АД/ЕАД/АДСИЦ (listed) excluded; hyphenated ООD name kept', () => {
  assert.equal(closelyHeldForm('ЕНЕРДЖИ СЪПЛАЙ ЕООД'), true);
  assert.equal(closelyHeldForm('"ТЕСТ АГРО" ЕООД'), true);
  assert.equal(closelyHeldForm('ЕТ Алекс'), true);
  assert.equal(closelyHeldForm('Вамос ООД'), true);
  assert.equal(closelyHeldForm('Тексим Банк АД'), false); // listed bank mis-filed in the ООД table
  assert.equal(closelyHeldForm('Наш Дом АД'), false);
  assert.equal(closelyHeldForm('Транспроект ЕАД'), false);
  assert.equal(closelyHeldForm('ТРЕЙС ГРУП ХОЛД АД'), false); // the €88M defamation trap
  assert.equal(closelyHeldForm('НЕС АДСИЦ'), false);
  assert.equal(closelyHeldForm('АД-ХОК ЕООД'), true); // „АД" glued by hyphen is not a form token
  assert.equal(closelyHeldForm('КАДИЕВ ГЛОБАЛ ЕООД'), true); // „АД" inside a word is not a form token
  // „АД" as a LEADING name token, with a closely-held suffix — the form is ООД/ЕООД, not joint-stock.
  // The old „match АД anywhere" rule wrongly excluded these (a dropped conflict); the suffix anchor fixes it.
  assert.equal(closelyHeldForm('АД ГРУП ООД'), true);
  assert.equal(closelyHeldForm('АД СТИЛ ЕООД'), true);
});

test('closelyHeldForm: КДА (командитно дружество с акции) is joint-stock and must be excluded', () => {
  // КДА issues shares like an АД — the shareholder book is not public, so a declared parcel is neither
  // verifiable nor necessarily material, which is the whole basis of the exclusion. It was missing from
  // both JOINT_STOCK and FORM_TOKENS, so a КДА read as closely-held and its holder could be published
  // as an owner. #279 rung 1 names it explicitly alongside АД and ЕАД.
  assert.equal(closelyHeldForm('ФИНАНС КДА'), false);
  assert.equal(closelyHeldForm('"АЛФА ИНВЕСТ" КДА'), false);
  assert.equal(closelyHeldForm('АЛФА КДА, гр. София'), false); // seat suffix must not rescue it
  // …and the mirror: „КДА" inside a word or as a leading token is not the form.
  assert.equal(closelyHeldForm('КДА-ТРЕЙД ЕООД'), true);
  assert.equal(closelyHeldForm('КДА ГРУП ООД'), true);
});

test('nameDistinctiveness: КДА counts as a legal form, not a content word', () => {
  // FORM_TOKENS feeds the content-word count. A form token counted as content inflates distinctiveness,
  // which is the direction that publishes prematurely.
  assert.equal(nameDistinctiveness('ФИНАНС КДА'), 'generic');
});

test('closelyHeldForm: a trailing седалище after the form does not flip an АД to closely-held (libel)', () => {
  // The declarant appended the seat to the name cell. Without stripping it, the end-anchored form test
  // misses the АД and returns closely-held=true → a listed-АД parcel presented as a material conflict.
  assert.equal(closelyHeldForm('ТРЕЙС ГРУП ХОЛД АД, гр. София'), false); // comma + гр. marker
  assert.equal(closelyHeldForm('Тексим Банк АД, София'), false); // comma + bare city (no marker)
  assert.equal(closelyHeldForm('Транспроект ЕАД гр.Пловдив'), false); // marker, no comma
  assert.equal(closelyHeldForm('НЕС АДСИЦ, обл. Варна'), false);
  // ...while a genuinely closely-held ООД keeps its material verdict even with a seat appended.
  assert.equal(closelyHeldForm('Вамос ООД, гр. Русе'), true);
  assert.equal(closelyHeldForm('ЕНЕРДЖИ СЪПЛАЙ ЕООД гр.Бургас'), true);
  // A comma-clause that itself bears a form is the фирма tail, not a seat — kept, so the anchor still reads it.
  assert.equal(closelyHeldForm('СТРОЙ, ИНВЕСТ АД'), false); // trailing clause has АД → joint-stock
  assert.equal(closelyHeldForm('СТРОЙ, ИНВЕСТ ООД'), true); // trailing clause has ООД → closely-held
});

test('the token set and the JOINT_STOCK regex name the SAME four forms', () => {
  // closelyHeldForm now decides on the last form TOKEN while deed.mjs's envelope test still uses the
  // end-anchored REGEX. Two spellings of one rule drift silently — the day one gains a form the other
  // lacks, a joint-stock company passes one gate and is barred by the other. Pin them to each other.
  // (deed.mjs's third spelling is pinned to the regex by deed.test.mjs:378.)
  for (const form of ['АД', 'ЕАД', 'АДСИЦ', 'КДА']) {
    assert.equal(JOINT_STOCK.test(`ФИРМА ${form}`), true, `regex misses ${form}`);
    assert.equal(closelyHeldForm(`ФИРМА ${form}`), false, `token set misses ${form}`);
    // …and the mirror: every form the regex accepts must be one the token set bars, seat or no seat.
    assert.equal(closelyHeldForm(`ФИРМА ${form} София`), false, `token set misses ${form} + seat`);
  }
  // Every FORM_TOKEN that is NOT one of the four must read as closely-held.
  for (const form of ['ЕООД', 'ООД', 'ЕТ', 'ДЗЗД', 'КД', 'СД']) {
    assert.equal(closelyHeldForm(`ФИРМА ${form}`), true, `${form} wrongly barred`);
  }
});

test('closelyHeldForm: a seat with NO comma and NO „гр." marker still cannot flip an АД (libel)', () => {
  // The gap the marker/comma rules leave open. `SEAT_MARKER` requires a literal dot and the comma-peel
  // requires a comma, so „ТРЕЙС ГРУП ХОЛД АД София" — the plainest way a declarant writes it — survives
  // both, no longer ENDS in the form, and the end-anchored JOINT_STOCK test misses it. A listed АД then
  // reads as closely-held: the „11 акции на Trace → €88M" trap, from the one input shape nothing strips.
  assert.equal(closelyHeldForm('ТРЕЙС ГРУП ХОЛД АД София'), false);
  assert.equal(closelyHeldForm('ТРЕЙС ГРУП ХОЛД АД СОФИЯ'), false);
  assert.equal(closelyHeldForm('Транспроект ЕАД Пловдив'), false);
  assert.equal(closelyHeldForm('НЕС АДСИЦ Варна'), false);
  assert.equal(closelyHeldForm('АЛФА КДА София'), false);
  // POSITIVE CONTROLS — the bar must stay a bound, not become a blanket. A predicate that always returned
  // false would pass every assertion above; these are what distinguish the fix from that (ADR-0027).
  assert.equal(closelyHeldForm('Вамос ООД Русе'), true); // dot-less seat on a closely-held form
  assert.equal(closelyHeldForm('ЕНЕРДЖИ СЪПЛАЙ ЕООД Бургас'), true);
  assert.equal(closelyHeldForm('АД ГРУП ООД'), true); // leading „АД" is not the form
  assert.equal(closelyHeldForm('АД-ХОК ЕООД'), true); // „АД" glued by a hyphen is not a form token
  assert.equal(closelyHeldForm('КДА ГРУП ООД'), true);
  assert.equal(closelyHeldForm('КАДИЕВ ГЛОБАЛ ЕООД'), true); // „АД" inside a word
  assert.equal(closelyHeldForm('ЕТ Алекс'), true); // ЕТ leads the фирма — nothing after it is a seat
});

test('nameDistinctiveness: a dot-less trailing city is not counted as a content word either', () => {
  // Same blind spot, and here it fails toward PUBLISHING: an uncounted seat token inflates the content-word
  // count to 3 ⇒ 'distinctive'. Since #279 rung 2 gates an uncorroborated „Документ" publish on exactly this
  // predicate (ADR-0035), a seat read as a content word is a false company-identity claim, not just noise.
  assert.equal(nameDistinctiveness('СТРОЙ ИНВЕСТ ООД София'), 'generic');
  assert.equal(nameDistinctiveness('НИКАС КОМЕРС ЕООД Пловдив'), 'generic');
  // POSITIVE CONTROLS: a genuinely ≥3-content-word фирма stays distinctive, and a leading-form ЕТ name
  // keeps its content words — nothing after „ЕТ" is a seat, so the strip must not reach them.
  assert.equal(nameDistinctiveness('ХИДРО СТРОЙ МОНТАЖ ЕООД София'), 'distinctive');
  assert.equal(nameDistinctiveness('ЕТ АЛЕКС ПЕТРОВ ДИМИТРОВ'), 'distinctive');
});

test('nameDistinctiveness: a trailing city is not counted as a content word (no premature publish)', () => {
  // The exact over-publish case: 2 real content words + a seat token would read as 3 → distinctive.
  assert.equal(nameDistinctiveness('СТРОЙ ИНВЕСТ ООД, СОФИЯ'), 'generic'); // was distinctive via +СОФИЯ
  assert.equal(nameDistinctiveness('НИКАС КОМЕРС ООД гр.Пловдив'), 'generic'); // marker, no comma
  assert.equal(nameDistinctiveness('СТРОЙ ИНВЕСТ ООД, обл. Варна'), 'generic');
  // A genuinely distinctive (≥3 content word) name stays distinctive with or without a seat.
  assert.equal(nameDistinctiveness('ХИДРО СТРОЙ МОНТАЖ ЕООД, гр. София'), 'distinctive');
});

test('localityToken: regional bodies yield a town; ministries yield null', () => {
  assert.equal(localityToken('Област - Русе'), 'РУСЕ');
  assert.equal(localityToken('Община Русе'), 'РУСЕ');
  assert.equal(localityToken('Министерство на здравеопазването'), null);
  assert.equal(localityToken('51-во Народно събрание'), null);
});
