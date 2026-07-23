import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nameDistinctiveness,
  seatConfirmed,
  publishTier,
  temporalStatus,
  localityToken,
  closelyHeldForm,
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

test('seatConfirmed: equal non-empty seats confirm; empty or mismatched do not', () => {
  assert.equal(seatConfirmed('Шумен', 'ШУМЕН'), true);
  assert.equal(seatConfirmed('София', 'Пловдив'), false);
  assert.equal(seatConfirmed('', 'София'), false); // sparse winner/declared seat never confirms
  assert.equal(seatConfirmed('София', ''), false);
});

test('publishTier: seat proof wins; else distinctiveness decides publish vs hold', () => {
  assert.equal(publishTier({ seatOk: true, distinctiveness: 'generic' }), 'A_seat');
  assert.equal(publishTier({ seatOk: false, distinctiveness: 'distinctive' }), 'B_distinctive');
  assert.equal(publishTier({ seatOk: false, distinctiveness: 'generic' }), 'C_hold');
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

test('localityToken: regional bodies yield a town; ministries yield null', () => {
  assert.equal(localityToken('Област - Русе'), 'РУСЕ');
  assert.equal(localityToken('Община Русе'), 'РУСЕ');
  assert.equal(localityToken('Министерство на здравеопазването'), null);
  assert.equal(localityToken('51-во Народно събрание'), null);
});
