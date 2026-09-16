// node:test — parsers over SYNTHETIC fixtures (no real PII). Two templates:
//   <PublicPerson>      asset decl — shares in the „дружества" tables (col 4 = company).
//   <PublicPersonDekl2> interests decl — participation/management/sole-trader (col 2) + related persons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseList, parseDeclaration, declarationDate } from './parse.mjs';

test('declaration dates preserve the supplied day and reject missing or impossible dates', () => {
  assert.equal(declarationDate(' 15. 5. 2026 '), '2026-05-15');
  assert.equal(declarationDate('06.12.2024г.'), '2024-12-06');
  assert.equal(declarationDate('2024-02-29T10:00:00'), '2024-02-29');
  assert.equal(declarationDate('29.02.2023'), null);
  assert.equal(declarationDate('31.04.2026'), null);
  assert.equal(declarationDate(''), null);
  assert.equal(declarationDate({}), null);
});

const LIST = `<?xml version="1.0"?>
<root><MainCategory><Category Name="Тест категория">
  <Institution Name="Тест институция">
    <Person><Name>Иван Петров Тестов</Name>
      <Position><Name>Директор</Name><Declaration><xmlFile>AAAA.xml</xmlFile></Declaration></Position>
    </Person>
    <Person><Name>Георги Иванов Второв</Name>
      <Position><Name>Член</Name><Declaration><xmlFile>BBBB.xml</xmlFile></Declaration></Position>
      <Position><Name>Зам.</Name><Declaration><xmlFile>CCCC.xml</xmlFile></Declaration></Position>
    </Person>
  </Institution>
</Category></MainCategory></root>`;

// --- asset template ---
function assetDecl({
  name = 'Иван Петров Тестов',
  year = '2023',
  egn = '',
  address = 'ул. Тестова 1',
  rows = '',
} = {}) {
  return `<?xml version="1.0"?>
<PublicPerson>
  <Personal><Name>${name}</Name><EGN>${egn}</EGN><Address>${address}</Address><Position>Директор</Position></Personal>
  <DeclarationData><Year>${year}</Year><DeclarationType>Годишна</DeclarationType><ControlHash>DEADBEEF</ControlHash></DeclarationData>
  <Tables><Table Num="10" Description="Дялове в дружества с ограничена отговорност">${rows}</Table></Tables>
</PublicPerson>`;
}
const selfRow = `<Row>
  <Cell Num="1" Description="Ном. по ред">1</Cell>
  <Cell Num="3" Description="Размер на дяловото участие">100%</Cell>
  <Cell Num="4" Description="Наименование на дружеството">"ТЕСТ АГРО" ЕООД</Cell>
  <Cell Num="5" Description="Седалище">София</Cell>
  <Cell Num="7" Description="Име: собствено, бащино, фамилно">Иван Петров Тестов</Cell>
  <Cell Num="8" Description="ЕГН"></Cell></Row>`;
const emptyRow = `<Row><Cell Num="1">2</Cell><Cell Num="4"></Cell></Row>`;
const familyRow = `<Row><Cell Num="1">3</Cell><Cell Num="4">"ФАМИЛНА" ЕООД</Cell><Cell Num="7">Мария Спасова Роднинска</Cell></Row>`;

// --- interests template ---
const interestsDecl = `<?xml version="1.0"?>
<PublicPersonDekl2>
  <Personal><Name>Георги Иванов Второв</Name><EGN></EGN><Position>Народен представител</Position></Personal>
  <DeclarationData><EntryDate>10.04.2025</EntryDate><DeclarationDate>09.04.2025</DeclarationDate><ControlHash>FC7C4B09</ControlHash></DeclarationData>
  <Tables>
    <Table Num="15" Description="Към датата на избирането: Имам участие в следните търговски дружества">
      <Row><Cell Num="1" Description="Ном. по ред">1</Cell><Cell Num="2" Description="Дружество">Ристовица ООД</Cell><Cell Num="3" Description="Размер на дяловото участие">1/2</Cell></Row></Table>
    <Table Num="16" Description="Към датата на избирането: Съм управител или член на орган на управление или контрол на търговски дружества">
      <Row><Cell Num="1">1</Cell><Cell Num="2" Description="Дружество">Велми Комерс ООД</Cell><Cell Num="3" Description="Участие">управител</Cell></Row></Table>
    <Table Num="18" Description="Дванадесет месеца преди датата на избирането: Имам участие в следните търговски дружества">
      <Row><Cell Num="1">1</Cell><Cell Num="2" Description="Дружество">Мейт Медия ООД</Cell><Cell Num="3">1/20</Cell></Row></Table>
    <Table Num="22" Description="Данни за свързани лица, към дейността на които">
      <Row><Cell Num="1">1</Cell><Cell Num="2" Description="Трите имена на лицето">Мария Спасова Роднинска</Cell><Cell Num="3" Description="Област на дейност">строителство</Cell></Row></Table>
  </Tables>
</PublicPersonDekl2>`;

test('parseList flattens the hierarchy and handles multiple persons/positions', () => {
  const rows = parseList(LIST);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.xmlFile),
    ['AAAA.xml', 'BBBB.xml', 'CCCC.xml'],
  );
});

test('asset decl: extracts self SHARES, skips empty template rows', () => {
  const d = parseDeclaration(assetDecl({ rows: selfRow + emptyRow }));
  assert.equal(d.templateType, 'assets');
  assert.deepEqual(d.interests, [
    {
      entity: '"ТЕСТ АГРО" ЕООД',
      kind: 'shares',
      detail: 'София',
      timing: 'annual',
      seat: 'София',
      holderRelation: 'self',
    },
  ]);
  assert.equal(d.familyHoldingCount, 0);
});

test('asset disposal is retained as an event and cannot masquerade as a holding', () => {
  const xml = assetDecl({ rows: selfRow }).replace(
    'Description="Дялове',
    'Description="Прехвърляне на дялове',
  );
  assert.equal(parseDeclaration(xml).interests[0].timing, 'disposed');
  assert.equal(parseDeclaration(assetDecl({ rows: selfRow })).interests[0].timing, 'annual');
});

test('official publication flags hide disabled tables, undeclared contents and disabled columns', () => {
  for (const flag of ['Disabled="True"', 'Disabled="False"', 'Declared="False"']) {
    const xml = assetDecl({ rows: selfRow }).replace('<Table Num=', `<Table ${flag} Num=`);
    assert.equal(parseDeclaration(xml).interests.length, 0, flag);
  }
  const hiddenCompany = selfRow.replace(
    'Num="4" Description=',
    'Num="4" Disabled="True" Description=',
  );
  assert.equal(parseDeclaration(assetDecl({ rows: hiddenCompany })).interests.length, 0);
  // The header hides the whole column, including subsequent rows without the attribute.
  const hiddenHolder = selfRow.replace(
    'Num="7" Description=',
    'Num="7" Disabled="True" Description=',
  );
  const d = parseDeclaration(assetDecl({ rows: hiddenHolder + familyRow }));
  assert.ok(d.interests.every((r) => r.holderRelation === 'unknown'));
  assert.equal(d.assetInventoryComparable, false);
});

test('a comparable inventory needs a visible recognised holding table, even when explicitly empty', () => {
  assert.equal(parseDeclaration(assetDecl({ rows: selfRow })).assetInventoryComparable, true);
  const empty = assetDecl({ rows: selfRow }).replace('<Table Num=', '<Table Declared="False" Num=');
  assert.equal(parseDeclaration(empty).assetInventoryComparable, true);
  assert.equal(parseDeclaration(assetDecl()).assetInventoryComparable, false);
  const disposed = assetDecl({ rows: selfRow }).replace(
    'Description="Дялове',
    'Description="Прехвърляне на дялове',
  );
  assert.equal(parseDeclaration(disposed).assetInventoryComparable, false);
});

test('a change form without an explicit time basis remains unknown; unrecognised versions do not publish', () => {
  const xml = `<PublicPersonDekl3><Personal><Name>Иван Петров Тестов</Name></Personal>
    <DeclarationData><DeclarationDate>12.09.2026</DeclarationDate></DeclarationData>
    <Tables><Table Num="4" Declared="True" Description="Имам / нямам участие в следните търговски дружества">
      <Row><Cell Num="2" Description="Дружество">Тест ЕООД</Cell></Row>
    </Table></Tables></PublicPersonDekl3>`;
  const d = parseDeclaration(xml);
  assert.equal(d.declarationType, 'Change');
  assert.equal(d.interests[0].timing, 'unknown');
  assert.equal(
    parseDeclaration(xml.replaceAll('PublicPersonDekl3', 'PublicPersonDekl99')).templateType,
    'unknown',
  );
  assert.equal(
    parseDeclaration(xml.replace('Declared="True"', 'Declared="False"')).interests.length,
    0,
  );
});

test('asset year comes from <Year>, not the folder (off-by-one guard)', () => {
  assert.equal(parseDeclaration(assetDecl({ year: '2023' })).year, '2023');
});

test('family holdings CAPTURED as related interests, holder names never retained', () => {
  const d = parseDeclaration(assetDecl({ rows: selfRow + familyRow }));
  assert.equal(d.familyHoldingCount, 1);
  assert.equal(d.interests.length, 2, 'family holding now captured, not discarded');
  const self = d.interests.find((i) => i.holderRelation === 'self');
  const fam = d.interests.find((i) => i.holderRelation === 'related');
  assert.equal(self.entity, '"ТЕСТ АГРО" ЕООД');
  assert.equal(fam.entity, '"ФАМИЛНА" ЕООД'); // the company is captured…
  assert.equal(fam.kind, 'shares');
  assert.ok(!JSON.stringify(d).includes('Мария'), 'family holder name leaked'); // …but the relative's NAME never is
});

test('asset decl: a self stake whose holder repeats the OWN name with case/spacing drift stays self', () => {
  // Declarations are hand-typed: the holder column often repeats the declarant's own name with different
  // casing/spacing than <Personal><Name>. An exact compare flips such a SELF stake to 'related' → a
  // fabricated family_ownership link naming a non-existent relative on a libel-sensitive surface. The
  // self/related decision must be case- and whitespace-insensitive.
  const variantSelfRow = `<Row>
    <Cell Num="1" Description="Ном. по ред">1</Cell>
    <Cell Num="4" Description="Наименование на дружеството">"ТЕСТ АГРО" ЕООД</Cell>
    <Cell Num="7" Description="Име: собствено, бащино, фамилно">ИВАН  ПЕТРОВ   ТЕСТОВ</Cell></Row>`;
  const d = parseDeclaration(assetDecl({ name: 'Иван Петров Тестов', rows: variantSelfRow }));
  assert.equal(d.interests.length, 1);
  assert.equal(
    d.interests[0].holderRelation,
    'self',
    'own name with case/space drift must not become a relative',
  );
  assert.equal(d.familyHoldingCount, 0, 'no fabricated family holding');
});

// АД securities table: issuer is in the „Емитент" column (≈col 6), NOT the ООД company column — a
// declarant's blue-chip share holding must not be mis-read as closely-held ownership.
const secDecl = `<?xml version="1.0"?>
<PublicPerson>
  <Personal><Name>Иван Петров Тестов</Name><EGN></EGN></Personal>
  <DeclarationData><Year>2023</Year><ControlHash>AB12</ControlHash></DeclarationData>
  <Tables><Table Num="9" Description="Ценни книги, поименни акции в акционерни дружества">
    <Row>
      <Cell Num="1" Description="Ном. по ред">1</Cell>
      <Cell Num="2" Description="Вид на ценните книги">акции</Cell>
      <Cell Num="3" Description="Брой на ценните книги">25</Cell>
      <Cell Num="4" Description="Ценни книжа"></Cell>
      <Cell Num="6" Description="Емитент">ТРЕЙС ГРУП ХОЛД АД</Cell>
      <Cell Num="8" Description="Име: собствено, бащино и фамилно">Иван Петров Тестов</Cell></Row></Table></Tables>
</PublicPerson>`;

test('asset decl: АД securities read from Емитент (col 6), tagged kind=securities', () => {
  const d = parseDeclaration(secDecl);
  assert.equal(d.interests.length, 1);
  assert.deepEqual(d.interests[0], {
    entity: 'ТРЕЙС ГРУП ХОЛД АД',
    kind: 'securities',
    detail: '',
    timing: 'annual',
    seat: '',
    holderRelation: 'self',
  });
});

test('address never extracted', () => {
  assert.ok(
    !JSON.stringify(
      parseDeclaration(assetDecl({ address: 'ул. Секретна 42', rows: selfRow })),
    ).includes('Секретна'),
  );
});

test('non-empty EGN raises egnPresent', () => {
  assert.equal(parseDeclaration(assetDecl({ egn: '' })).egnPresent, false);
  assert.equal(parseDeclaration(assetDecl({ egn: '7501011234' })).egnPresent, true);
});

test('interests decl: participation + MANAGEMENT + timing, from <PublicPersonDekl2>', () => {
  const d = parseDeclaration(interestsDecl);
  assert.equal(d.templateType, 'interests');
  assert.equal(d.year, '2025'); // from DeclarationDate
  const byKind = (k) => d.interests.filter((i) => i.kind === k);
  assert.deepEqual(
    byKind('participation').map((i) => [i.entity, i.detail, i.timing]),
    [
      ['Ристовица ООД', '1/2', 'current'],
      ['Мейт Медия ООД', '1/20', 'prior'],
    ],
  );
  assert.deepEqual(
    byKind('management').map((i) => [i.entity, i.detail]),
    [['Велми Комерс ООД', 'управител']],
  );
});

test('interests decl: related persons are SEPARATED (never in interests, name only in relatedPersons)', () => {
  const d = parseDeclaration(interestsDecl);
  assert.ok(
    !d.interests.some((i) => i.entity.includes('Мария')),
    'related person leaked into interests',
  );
  assert.equal(d.relatedPersons.length, 1);
  assert.equal(d.relatedPersons[0].kind, 'related_person');
  assert.equal(d.relatedPersons[0].name, 'Мария Спасова Роднинска');
});

test('interests template versions (Dekl3) dispatch by root, classify by description not table number', () => {
  // Dekl3 = same interests decl, tables renumbered 1-9. Management table is T2 here, not T16.
  const dekl3 = interestsDecl
    .replace(/PublicPersonDekl2/g, 'PublicPersonDekl3')
    .replace('Num="16"', 'Num="2"');
  const d = parseDeclaration(dekl3);
  assert.equal(d.templateType, 'interests');
  assert.ok(d.interests.some((i) => i.kind === 'management' && i.entity === 'Велми Комерс ООД'));
});

test('unknown root returns an empty record, not an error', () => {
  const d = parseDeclaration('<?xml version="1.0"?><Something/>');
  assert.equal(d.templateType, 'unknown');
  assert.deepEqual(d.interests, []);
});

test('XXE guard rejects DOCTYPE/ENTITY input', () => {
  const evil = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><PublicPerson/>`;
  assert.throws(() => parseDeclaration(evil), /XXE guard/);
  assert.throws(() => parseList(evil), /XXE guard/);
});

// The register announces placeholder rows that name no document — `<Sent>False</Sent><xmlFile>U</xmlFile>`
// with `<Title>Уведомление</Title>`. 87 of them sit across 15 sets. A bare truthiness test on xmlFile
// accepted 'U' as a filename, so the crawler announced a declaration that does not exist, failed to fetch
// it, and booked an error — pinning the completeness gate below the announced count for those sets forever.
const LIST_WITH_PHANTOM = `<?xml version="1.0"?>
<root><MainCategory><Category Name="Тест категория">
  <Institution Name="Тест институция">
    <Person><Name>Иван Петров Тестов</Name>
      <Position><Name>Директор</Name>
        <Declaration><xmlFile>REAL.xml</xmlFile></Declaration>
        <Declaration><Sent>False</Sent><xmlFile>U</xmlFile><Title>Уведомление</Title></Declaration>
      </Position>
    </Person>
  </Institution>
</Category></MainCategory></root>`;

test('parseList: a placeholder row naming no file is NOT announced', () => {
  const rows = parseList(LIST_WITH_PHANTOM);
  assert.equal(rows.length, 1, 'only the row bearing a real filename counts');
  assert.equal(rows[0].xmlFile, 'REAL.xml');
});

test('parseList: only values shaped like a declaration filename are announced', () => {
  const shape = (v) =>
    parseList(`<?xml version="1.0"?>
<root><MainCategory><Category Name="к"><Institution Name="и">
  <Person><Name>Име Име Име</Name><Position><Name>п</Name>
    <Declaration><xmlFile>${v}</xmlFile></Declaration>
  </Position></Person>
</Institution></Category></MainCategory></root>`).length;
  assert.equal(shape('AAAA.xml'), 1);
  assert.equal(shape('U'), 0, 'the register placeholder');
  assert.equal(shape(''), 0);
  assert.equal(shape('Уведомление'), 0, 'a title slotted into the filename field');
  assert.equal(shape('AAAA.pdf'), 0, 'not a declaration document');
});

test('§1.4: an UNRESOLVABLE holder column is unknown, not an own stake', () => {
  // `colNum` always returns a fallback, so a table that renumbers the holder column away resolves it to a
  // column that is not there: `by[cHolder]` is undefined → '' → classifyHolder('') → 'self'. A RELATIVE's
  // stake then enters the OWN-only path and publishes as the official's private_ownership — the surface's
  // worst failure, since the official did not declare that stake as theirs.
  //
  // Neither a resolvable-but-empty holder nor an unresolved column proves ownership
  // versus column NOT RESOLVABLE (→ unknown, we have not read the holder at all).
  const renumbered = `<Row>
    <Cell Num="1" Description="Ном. по ред">1</Cell>
    <Cell Num="4" Description="Наименование на дружеството">"РЕНОМЕР" ЕООД</Cell>
    <Cell Num="9" Description="Титуляр на дяловете">Мария Спасова Роднинска</Cell></Row>`;
  const d = parseDeclaration(assetDecl({ rows: renumbered }), 'REN.xml');
  const it = d.interests.find((i) => i.entity === '"РЕНОМЕР" ЕООД');
  assert.equal(it.holderRelation, 'unknown');

  // A resolvable but empty column is also unknown; it does not identify the holder.
  const blankHolder = `<Row>
    <Cell Num="1" Description="Ном. по ред">1</Cell>
    <Cell Num="4" Description="Наименование на дружеството">"ПРАЗНА" ЕООД</Cell>
    <Cell Num="7" Description="Име: собствено, бащино, фамилно"></Cell></Row>`;
  const blank = parseDeclaration(assetDecl({ rows: blankHolder }), 'BLK.xml');
  assert.equal(blank.interests[0].holderRelation, 'unknown');

  // POSITIVE CONTROL 2 — a resolvable column still classifies a relative and the declarant correctly, so
  // the change bounds one case rather than blanketing the parser.
  const ok = parseDeclaration(assetDecl({ rows: selfRow + familyRow }), 'OK.xml');
  assert.equal(ok.interests.find((i) => i.entity === '"ТЕСТ АГРО" ЕООД').holderRelation, 'self');
  assert.equal(ok.interests.find((i) => i.entity === '"ФАМИЛНА" ЕООД').holderRelation, 'related');
});
