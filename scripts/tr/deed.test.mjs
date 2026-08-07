// node:test — the deed parser. Pure, offline, and the most dangerous code in this change.
//
// Every fixture below is REAL markup, copied verbatim from a live deed (ЕИК 115536179, fetched
// 2026-08-05) with person names replaced only where a test needs a specific shape. Writing this
// parser against imagined markup is how the entity-boundary bug ships.
//
// The failure this file exists to prevent: field CR_F_19_L holds THREE separate people in one string,
// separated by <hr class='hr--report' />. Matching a declarant's tokens against the whole field lets
// the given name of one person combine with the surname of another, and the result is a named public
// claim that a specific official owns a specific company — about the wrong person. ADR-0033 decision 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  entityBlocks,
  liveFields,
  personTokens,
  fullSubsetMatch,
  normalizeSettlement,
  registrySeat,
  registryLegalForm,
  latestOwnershipEntryDate,
  assertUicEcho,
  JOINT_SUFFIX,
} from './deed.mjs';

// ── real markup ───────────────────────────────────────────────────────────────
const F19_THREE = `<div class='record-container record-container--preview'><p class='field-text'>ПИМК ХОЛДИНГ ГРУП АД, ЕИК/ПИК 202294392, Държава: БЪЛГАРИЯ, Размер на дяловото участие: 59980.00 лв.</p></div><hr class='hr--report' /><div class='record-container record-container--preview'><p class='field-text'>ПЕНКО НЕСТОРОВ НЕСТОРОВ, Държава: БЪЛГАРИЯ, Размер на дяловото участие: 10.00 лв.</p></div><hr class='hr--report' /><div class='record-container record-container--preview'><p class='field-text'>ИЛИЯН КОСТАДИНОВ ФИЛИПОВ, Държава: БЪЛГАРИЯ, Размер на дяловото участие: 10.00 лв.</p></div>`;

const F23_ERASED = `<div class='record-container record-container--preview'><div class='erasure-text-inline'><i class='ui-icon ui-icon-erased mr-1'></i>Заличено обстоятелство.</div></div>`;

const F5_SEAT = `<div class='record-container record-container--preview'><p class='field-text'>Държава: БЪЛГАРИЯ<br/>Област: Пловдив, Община: Родопи<br />Населено място: с. Марково, п.к. 4108<br/>бул./ул. местност ЗАХАРИДЕВО № 043А Телефон: 032/901102 и 032/945149<br/>Адрес на електронна поща: <a style="text-decoration:underline;color:black" href="mailto:office@pimk-bg.eu">office@pimk-bg.eu</a></p></div>`;

const F7_MANAGER = `<div class='record-container record-container--preview'><p class='field-text'>АНТОН ИЦКОВ ЙОРДАНОВ, Държава: БЪЛГАРИЯ</p></div>`;

const field = (nameCode, htmlData, over = {}) => ({
  nameCode,
  htmlData,
  fieldEntryNumber: '20130716101007',
  fieldEntryDate: '2013-07-16T10:10:07',
  fieldOperation: 3,
  fieldIdent: '00190',
  ...over,
});
const deedOf = (fields, over = {}) => ({
  uic: '115536179',
  fullName: '"ПИМК" ООД',
  legalForm: 4,
  sections: [{ subDeeds: [{ groups: [{ fields }] }] }],
  ...over,
});

// ── T1 — the entity boundary ──────────────────────────────────────────────────
test('entityBlocks splits one field into its separate registered entities', () => {
  const blocks = entityBlocks(F19_THREE);
  assert.equal(blocks.length, 3, 'three съдружници, three blocks');
  assert.match(blocks[0].text, /ПИМК ХОЛДИНГ ГРУП АД/);
  assert.match(blocks[1].text, /ПЕНКО НЕСТОРОВ НЕСТОРОВ/);
  assert.match(blocks[2].text, /ИЛИЯН КОСТАДИНОВ ФИЛИПОВ/);
  // No block may carry another block's name — that is the whole point.
  assert.ok(!blocks[1].text.includes('ФИЛИПОВ'));
  assert.ok(!blocks[2].text.includes('ПЕНКО'));
});

test('T1 — tokens from two DIFFERENT people never combine into a match', () => {
  // „ПЕНКО … НЕСТОРОВ" and „ИЛИЯН КОСТАДИНОВ ФИЛИПОВ" are both in field 19. A declarant assembled
  // from one person's given name and another's patronymic+surname must NOT match.
  const frankenstein = 'ПЕНКО КОСТАДИНОВ ФИЛИПОВ';
  const blocks = entityBlocks(F19_THREE);
  assert.equal(
    blocks.some((b) => fullSubsetMatch(frankenstein, b.text)),
    false,
    'cross-entity match — this is the libel bug',
  );
  // Whole-field matching is exactly what must not be done; prove the naive approach WOULD have fired,
  // so this test cannot silently pass because the matcher is broken in some other way.
  assert.equal(fullSubsetMatch(frankenstein, F19_THREE), true, 'naive whole-field match fires');
});

// The live register emits single-quoted attributes today, and every fixture above is verbatim from a
// real deed. But the entity split is the ONLY thing standing between three people and one merged
// token pool, and it must not be quiet about a markup change: if the register ever switches to
// class="…", a quote-specific pattern stops splitting, all three owners collapse into one block, and
// the frankenstein match above starts firing — a named public claim about a person who is not there.
// R7's doctrine for this module is „refuse loudly, never guess"; silently mis-splitting is neither.
const dq = (s) => s.replace(/class='([^']*)'/g, 'class="$1"');

test('T1 — the entity split survives double-quoted attributes (markup-drift hardening)', () => {
  // Strip the <hr> separators first. entityBlocks splits on BOTH <hr> and record-container precisely
  // because either may be absent; with the <hr> present this test would pass on the <hr> rule alone
  // and prove nothing about the quote handling it is here to pin.
  const blocks = entityBlocks(dq(F19_THREE).replace(/<hr\b[^>]*>/gi, ''));
  assert.equal(blocks.length, 3, 'a quote style change must not merge three owners into one block');
  assert.equal(
    blocks.some((b) => fullSubsetMatch('ПЕНКО КОСТАДИНОВ ФИЛИПОВ', b.text)),
    false,
    'cross-entity match under double quotes — the libel bug via markup drift',
  );
  assert.ok(blocks.some((b) => fullSubsetMatch('ПЕНКО НЕСТОРОВ НЕСТОРОВ', b.text)));
});

test('T1 — erasure is still detected and stripped under double-quoted attributes', () => {
  const [block] = entityBlocks(dq(F23_ERASED));
  assert.equal(block.erased, true);
  assert.equal(block.text, '', 'the erasure notice must not survive as content');
  // The strict contradiction check must not fire merely because the quote style changed.
  assert.doesNotThrow(() => entityBlocks(dq(F23_ERASED), { strict: true }));
});

test('T1 positive control — the CORRECT declarant does match', () => {
  // Without this, a matcher that always returns false passes every negative test above (ADR-0027).
  const blocks = entityBlocks(F19_THREE);
  assert.equal(
    blocks.some((b) => fullSubsetMatch('ИЛИЯН КОСТАДИНОВ ФИЛИПОВ', b.text)),
    true,
  );
  assert.equal(
    blocks.some((b) => fullSubsetMatch('Пенко Несторов Несторов', b.text)),
    true,
    'case/spacing drift still matches within the right entity',
  );
});

test('T1 — HTML entities are decoded BEFORE splitting, not after', () => {
  // Decode-after-split leaves &quot;-bearing names mangled; decode-before-split is the tested order.
  const encoded = F19_THREE.replace('ПИМК ХОЛДИНГ ГРУП АД', '&quot;ПИМК ХОЛДИНГ ГРУП&quot; АД');
  const blocks = entityBlocks(encoded);
  assert.equal(blocks.length, 3);
  assert.match(blocks[0].text, /"ПИМК ХОЛДИНГ ГРУП" АД/);
  assert.ok(!blocks[0].text.includes('&quot;'), 'entities must be decoded');
});

test('T1 — a corporate съдружник contributes its own tokens, not a person match', () => {
  // „ПИМК ХОЛДИНГ ГРУП АД, ЕИК/ПИК 202294392" is a legal entity. A person whose name happens to
  // overlap its words must not match it into existence.
  const blocks = entityBlocks(F19_THREE);
  assert.equal(
    fullSubsetMatch('ПИМК ХОЛДИНГ ГРУП', blocks[0].text),
    true,
    'literal overlap exists',
  );
  // …which is why rung 2 requires ≥3 tokens of a PERSON name; the guard lives in evidence.mjs (T2).
});

// ── erasure ───────────────────────────────────────────────────────────────────
test('an erased entity is detected structurally and dropped from live state', () => {
  // MEASURED: the live deed marks erasure with `erasure-text-inline` and the container carries NO
  // <p class='field-text'> at all. An earlier note claimed the marker was `field-text--erased`; that
  // class does not occur in the sampled deed. Both are treated as erasure so either shape is safe.
  const blocks = entityBlocks(F23_ERASED);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].erased, true);
  const live = liveFields(deedOf([field('CR_F_23_L', F23_ERASED, { fieldOperation: 2 })]), [
    'CR_F_23_L',
  ]);
  assert.deepEqual(live, [], 'an erased field contributes no live entity');
});

test('the OTHER erasure spelling is honoured too', () => {
  const alt = `<div class='record-container'><p class='field-text field-text--erased'>СТАР СОБСТВЕНИК</p><div class='erasure-text-inline'>Заличено обстоятелство.</div></div>`;
  assert.equal(entityBlocks(alt)[0].erased, true);
});

test('an erased-looking block carrying real content REFUSES the deed (drift alarm)', () => {
  // R7: "erased ⇒ empty" is an empirical observation (93 of 93). If the register ever emits an erased
  // marker beside live content, the assumption is broken and we must stop, not silently drop a real
  // owner or silently keep a removed one.
  const contradictory = `<div class='record-container'><p class='field-text'>ЖИВО ИМЕ ТУК</p><div class='erasure-text-inline'>Заличено обстоятелство.</div></div>`;
  assert.throws(() => entityBlocks(contradictory, { strict: true }), /erased.*content|drift/i);
});

test('an empty htmlData yields no entities and does not throw', () => {
  assert.deepEqual(entityBlocks(''), []);
  assert.deepEqual(entityBlocks(null), []);
});

// A numeric entity is attacker-shaped input in the only sense that matters here: it comes off the
// wire, and `String.fromCodePoint` throws RangeError above U+10FFFF. That throw escapes decodeEntities,
// escapes entityBlocks and registrySeat, and — because the crawl loop's try/catch covers only
// JSON.parse + assertUicEcho — escapes run() and kills the process. One malformed entity in one deed
// would end a paced crawl that has already spent its request budget. Out of range is not a person, so
// the only defensible reading is „no character": drop it and keep parsing the rest of the entity.
test('an out-of-range numeric entity is dropped, never thrown out of the parser', () => {
  const overflow = F19_THREE.replace('ПЕНКО', '&#999999999999;ПЕНКО');
  const blocks = entityBlocks(overflow);
  assert.equal(blocks.length, 3, 'the deed still parses into its three entities');
  assert.match(blocks[1].text, /ПЕНКО НЕСТОРОВ НЕСТОРОВ/, 'the surrounding name survives intact');
  assert.ok(!blocks[1].text.includes('&#'), 'the escape itself does not survive as literal text');
});

test('the hex numeric form is guarded too — both decode lines, not just the decimal one', () => {
  const overflow = F19_THREE.replace('ИЛИЯН', '&#xFFFFFFFF;ИЛИЯН');
  const blocks = entityBlocks(overflow);
  assert.equal(blocks.length, 3);
  assert.match(blocks[2].text, /ИЛИЯН КОСТАДИНОВ ФИЛИПОВ/);
});

test('an in-range numeric entity still decodes — the guard bounds, it does not disable', () => {
  // &#1055; is „П". A guard that dropped every numeric escape would silently mangle real names.
  const blocks = entityBlocks(F19_THREE.replace('ПЕНКО', '&#1055;ЕНКО'));
  assert.match(blocks[1].text, /ПЕНКО НЕСТОРОВ НЕСТОРОВ/);
});

test('registrySeat survives the same malformed entity rather than aborting the load', () => {
  // registrySeat sits OUTSIDE the crawl loop's refuse-and-continue block (fetch-deeds.mjs), and
  // load.mjs calls it again at decision time — so an unguarded throw here takes down both legs.
  const d = deedOf([field('CR_F_5_L', F5_SEAT.replace('с. Марково', '&#999999999999;с. Марково'))]);
  const seat = registrySeat(d);
  assert.equal(seat.settlement, 'МАРКОВО');
});

test('liveFields keeps only the requested codes and reports entry date/number', () => {
  const d = deedOf([
    field('CR_F_7_L', F7_MANAGER, { nameCode: 'CR_F_7_L', fieldEntryDate: '2017-09-15T00:00:00' }),
    field('CR_F_19_L', F19_THREE),
    field('CR_F_5_L', F5_SEAT),
  ]);
  const live = liveFields(d, ['CR_F_7_L', 'CR_F_19_L']);
  assert.deepEqual(live.map((f) => f.nameCode).sort(), ['CR_F_19_L', 'CR_F_7_L']);
  const f19 = live.find((f) => f.nameCode === 'CR_F_19_L');
  assert.equal(f19.entities.length, 3);
  assert.equal(f19.entryDate, '2013-07-16');
  assert.equal(f19.entryNumber, '20130716101007');
  assert.equal(typeof f19.entryNumber, 'string', 'entry numbers exceed 2^53 — never a number');
});

// ── T2 — the token rule ───────────────────────────────────────────────────────
test('personTokens keeps tokens of length ≥2 and folds case/spacing', () => {
  assert.deepEqual(personTokens('Иван Петров Георгиев'), ['ИВАН', 'ПЕТРОВ', 'ГЕОРГИЕВ']);
  assert.deepEqual(personTokens('  иван   петров  '), ['ИВАН', 'ПЕТРОВ']);
  // An initial is not a token — „Г. И. Петров" is ONE token, so it can never reach three.
  assert.deepEqual(personTokens('Г. И. Петров'), ['ПЕТРОВ']);
  // A hyphenated surname is one token, not two.
  assert.deepEqual(personTokens('Мария Иванова-Петрова'), ['МАРИЯ', 'ИВАНОВА', 'ПЕТРОВА']);
});

test('fullSubsetMatch requires EVERY declarant token, not a majority', () => {
  const entity = 'ИЛИЯН КОСТАДИНОВ ФИЛИПОВ, Държава: БЪЛГАРИЯ';
  assert.equal(fullSubsetMatch('ИЛИЯН КОСТАДИНОВ ФИЛИПОВ', entity), true);
  // 2-of-3 must fail: of 301 measured matches, 46 were two-token only — the homonym risk itself.
  assert.equal(fullSubsetMatch('ИЛИЯН КОСТАДИНОВ ПЕТРОВ', entity), false);
  assert.equal(fullSubsetMatch('ИЛИЯН ПЕТРОВ ФИЛИПОВ', entity), false);
});

test('a token must match a WHOLE token, never a substring', () => {
  // „ПЕТРОВ" must not be found inside „ПЕТРОВА"; that is a different person.
  assert.equal(fullSubsetMatch('ИВАН ПЕТРОВ ГЕОРГИЕВ', 'ИВАН ПЕТРОВА ГЕОРГИЕВА'), false);
});

// ── T5 — settlement normalization ─────────────────────────────────────────────
test('T5 — the settlement prefix is stripped only as a whole token', () => {
  // R9: a naive prefix strip turns СОФИЯ into ОФИЯ and ГРАДЕЦ into АДЕЦ.
  assert.equal(normalizeSettlement('гр. Русе'), 'РУСЕ');
  assert.equal(normalizeSettlement('с. Марково'), 'МАРКОВО');
  assert.equal(normalizeSettlement('София'), 'СОФИЯ');
  assert.equal(normalizeSettlement('СОФИЯ'), 'СОФИЯ');
  assert.equal(normalizeSettlement('Градец'), 'ГРАДЕЦ');
  assert.equal(normalizeSettlement('гр.Пловдив'), 'ПЛОВДИВ');
  assert.equal(normalizeSettlement('София (столица)'), 'СОФИЯ');
});

test('T5 — an empty settlement never equals another empty settlement', () => {
  // „both blank ⇒ confirmed" would rubber-stamp every link with no seat data at all.
  assert.equal(normalizeSettlement(''), '');
  assert.equal(normalizeSettlement(null), '');
  assert.equal(normalizeSettlement('   '), '');
});

test('registrySeat reads the „Населено място" segment and NOTHING else', () => {
  const seat = registrySeat(deedOf([field('CR_F_5_L', F5_SEAT, { nameCode: 'CR_F_5_L' })]));
  assert.equal(seat.settlement, 'МАРКОВО');
  assert.equal(seat.entryDate, '2013-07-16');
  // ADR-0010 item 3: the parser never returns an address, phone, e-mail or website — and the deed
  // demonstrably carries all four.
  const blob = JSON.stringify(seat);
  for (const leak of ['ЗАХАРИДЕВО', '032/901102', 'office@pimk-bg.eu', 'п.к.', '4108', 'Родопи'])
    assert.ok(!blob.includes(leak), `seat must not carry ${leak}`);
});

// ── T3 — the joint-stock bar ──────────────────────────────────────────────────
test('T3 — the legal-form verdict is a UNION of the code and the ЗТРРЮЛНЦ suffix', () => {
  const jointByCode = registryLegalForm(deedOf([], { legalForm: 5, fullName: 'НЕЩО СИ' }));
  assert.equal(jointByCode.verdict, 'joint_stock');

  // An UNKNOWN code must not fall through: the suffix decides, and if it cannot, we withhold.
  const unknownButEad = registryLegalForm(deedOf([], { legalForm: 99, fullName: '"ГАМА" ЕАД' }));
  assert.equal(unknownButEad.verdict, 'joint_stock', 'barred by the mandated suffix');

  const unknownButEood = registryLegalForm(deedOf([], { legalForm: 99, fullName: '"БЕТА" ЕООД' }));
  assert.equal(unknownButEood.verdict, 'closely_held', 'the bar is not blanket');

  const unknownAndUnreadable = registryLegalForm(deedOf([], { legalForm: 99, fullName: 'НЕЩО' }));
  assert.equal(unknownAndUnreadable.verdict, 'unknown', 'unknown withholds — it never publishes');
});

test('T3 — КДА is barred (it is not in the existing closelyHeldForm token list)', () => {
  assert.equal(
    registryLegalForm(deedOf([], { legalForm: 99, fullName: '"X" КДА' })).verdict,
    'joint_stock',
  );
  assert.equal(
    registryLegalForm(deedOf([], { legalForm: 6, fullName: 'X' })).verdict,
    'joint_stock',
  );
});

test('T3 — a real ООД deed reads as closely held, by code AND by suffix', () => {
  const v = registryLegalForm(deedOf([]));
  assert.equal(v.code, 4);
  assert.equal(v.verdict, 'closely_held');
  assert.equal(v.suffixVerdict, 'closely_held', 'fullName carries the form: "ПИМК" ООД');
});

// ── T7 — the UIC echo ─────────────────────────────────────────────────────────
test('T7 — a deed whose UIC does not echo the request is REFUSED', () => {
  // R8: ЕИК leading zeros are significant (public bodies are exactly 000…). If anything on the path
  // rewrites the identifier, this is the rail that catches it before a claim is made about the
  // wrong company.
  assert.doesNotThrow(() => assertUicEcho(deedOf([]), '115536179'));
  assert.throws(() => assertUicEcho(deedOf([]), '000696327'), /uic|echo/i);
  assert.throws(() => assertUicEcho(deedOf([], { uic: '696327' }), '000696327'), /uic|echo/i);
  assert.throws(() => assertUicEcho(deedOf([], { uic: null }), '115536179'), /uic|echo/i);
});

// ── the refutation input ──────────────────────────────────────────────────────
test('latestOwnershipEntryDate ignores ERASED ownership fields', () => {
  // The trap, present in the first company sampled: CR_F_23_L is live in the current deed, dated
  // 2013-07-16, and contains only „Заличено обстоятелство.". Read naively it becomes „latest
  // ownership entry: 2013-07-16" and can refute a link it knows nothing about.
  const d = deedOf([
    field('CR_F_19_L', F19_THREE, { fieldEntryDate: '2011-05-02T00:00:00' }),
    field('CR_F_23_L', F23_ERASED, { fieldEntryDate: '2013-07-16T10:10:07', fieldOperation: 2 }),
  ]);
  assert.equal(latestOwnershipEntryDate(d), '2011-05-02', 'the erased 2013 entry must not count');
});

test('latestOwnershipEntryDate is null when no live ownership field survives', () => {
  const d = deedOf([field('CR_F_23_L', F23_ERASED, { fieldOperation: 2 })]);
  assert.equal(latestOwnershipEntryDate(d), null);
});

// The erasure-notice strip used an unbounded lazy `.*?`, which backtracks quadratically when the opening
// div is never closed — each opening restarts a scan to end-of-input. Measured on that shape: 34K→3.3ms,
// 68K→13.6ms, 136K→53.8ms, 272K→240ms, 1M→4.0s (×4 per doubling). The parser runs against whatever the
// register returns, so that is remote-controlled CPU on a paced crawl with a per-request budget.
test('adversarial unclosed markup parses in linear time, not quadratically', () => {
  // ~1 MB of unclosed erasure openings — the exact shape that triggers the backtracking.
  const doc = '<div class="erasure-text-inline">z'.repeat(32_000);
  const t = process.hrtime.bigint();
  entityBlocks(doc);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  // Bounded measures ~190ms here and unbounded ~4000ms, so 1500ms separates them with ~8× headroom
  // over the bounded path — wide enough not to flake on a loaded runner, tight enough to catch a
  // reintroduced `.*?`.
  assert.ok(ms < 1500, `entityBlocks took ${ms.toFixed(0)}ms on 1MB of unclosed markup`);
});

test('an over-long erasure notice still marks the block erased — the bound cannot leak a live owner', () => {
  // If the notice exceeds the bound the regex simply does not strip it. `erased` is decided separately
  // by ERASED_MARKER, so the block is still erased and liveFields still drops it: the failure mode of
  // the bound is a noisier block, never a resurrected owner.
  const long = `<div class='record-container'><div class='erasure-text-inline'>${'Заличено. '.repeat(400)}</div></div>`;
  const [block] = entityBlocks(long);
  assert.equal(block.erased, true);
  assert.deepEqual(
    liveFields(deedOf([field('CR_F_19_L', long)]), ['CR_F_19_L']),
    [],
    'an erased block contributes no live entity regardless of its notice length',
  );
});

// JOINT_SUFFIX here and JOINT_STOCK in scripts/cacbg/classify.mjs are the SAME rule — which legal-form
// suffixes mark a share-issuing company — held in two places because the TR parser cannot import out of
// scripts/cacbg/ without closing a cacbg↔tr cycle. The drift this risks has already happened once: 5f64f5c
// added КДА to classify.mjs while deed.mjs's comment still asserted it was absent there. A prose „keep
// these in step" note does not keep anything in step; this does.
test('the joint-stock suffix rule is identical in the TR parser and the classifier', async () => {
  const { JOINT_STOCK } = await import('../cacbg/classify.mjs');
  assert.equal(JOINT_SUFFIX.source, JOINT_STOCK.source, 'the two patterns have diverged');
  assert.equal(JOINT_SUFFIX.flags, JOINT_STOCK.flags, 'the two patterns have diverged in flags');
  // Behavioural pin as well as textual: identical sources with different behaviour is impossible, but a
  // future refactor could legitimately change BOTH sources while breaking one. These are the forms the
  // bar exists for — every one must be caught by both, or a joint-stock parcel publishes as ownership.
  for (const name of ['ТРЕЙС ГРУП ХОЛД АД', 'НЕЩО ЕАД', 'ФОНД АДСИЦ', 'НЕЩО КДА']) {
    assert.equal(JOINT_SUFFIX.test(name), true, name);
    assert.equal(JOINT_STOCK.test(name), true, name);
  }
  for (const name of ['АЛФА СТРОЙ ООД', 'БЕТА ЕООД', 'АД ГРУП ООД']) {
    assert.equal(JOINT_SUFFIX.test(name), false, name);
    assert.equal(JOINT_STOCK.test(name), false, name);
  }
});
