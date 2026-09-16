// The partida-to-roles mapper, on entries in the register's real shape (fictional values). An Add entry lists
// a field's holders in full, as they stand after it; an Erase entry carries no records and removes the whole
// field. A record carries its holder as a Person or a Subject — Indent, IndentType, Name, country, legal form
// — with the share beside it.
import { describe, expect, it } from 'vitest';
import type { RegistryDeed, RegistryField } from './registry';
import { ROLE_FIELDS, deedFacts, rolesFromDeed } from './registry-roles';

const field = (over: Partial<RegistryField>): RegistryField => ({
  fieldIdent: '00070',
  element: 'Managers',
  operation: 'Add',
  entryNumber: '20080103104729',
  actionDate: '2008-01-03T10:47:29',
  entryDate: '2008-01-03T10:47:29',
  value: {},
  ...over,
});
/** An entry made on a given day; its number follows the day, as the register's do. */
const on = (d: string, over: Partial<RegistryField>): RegistryField =>
  field({
    entryNumber: `${d.replaceAll('-', '')}090000`,
    actionDate: `${d}T09:00:00`,
    entryDate: `${d}T09:00:00`,
    ...over,
  });
const partidaOf = (...subDeeds: { subUic: string; fields: RegistryField[] }[]): RegistryDeed => {
  const body = {
    uic: '101010101',
    name: 'ПРИМЕР ЕООД',
    status: 'N',
    guid: 'g',
    legalForm: 'EOOD',
    subDeeds: subDeeds.map((s) => ({
      subUic: s.subUic,
      subUicType: 'MainCircumstances',
      status: 'A',
      fields: s.fields,
    })),
  };
  return { deed: body, deedActualState: body };
};
const partida = (...fields: RegistryField[]) => partidaOf({ subUic: '0000', fields });
// The register's person hash is 64 hex characters.
const hash = (c: string) => c.repeat(64).slice(0, 64);
const person = (c: string, name: string) => ({ Indent: hash(c), IndentType: 'EGN', Name: name });
const managers = (...people: [c: string, name: string, recordId?: string][]) => ({
  Manager: people.map(([c, name, recordId], i) => ({
    RecordID: recordId ?? String(i + 1),
    GroupID: '1',
    Person: person(c, name),
  })),
});

describe('rolesFromDeed', () => {
  it('ends a role at the first later entry that no longer lists the holder, whatever its record id', () => {
    const { roles, persons } = rolesFromDeed(
      '101010101',
      partida(
        on('2008-01-03', { value: managers(['a', 'ИМЕ ЕДНО', '10']) }),
        // The first stays — under a new record id — and a second joins; the entry lists both.
        on('2015-06-01', { value: managers(['a', 'ИМЕ ЕДНО', '31'], ['b', 'ИМЕ ДВЕ', '32']) }),
        on('2018-02-20', { value: managers(['b', 'ИМЕ ДВЕ', '32']) }),
      ),
    );
    expect(roles.map((r) => [r.subjectId, r.addedOn, r.removedOn])).toEqual([
      [hash('a'), '2008-01-03', '2018-02-20'],
      [hash('b'), '2015-06-01', null],
    ]);
    expect(roles[0]).toMatchObject({
      subUic: '0000',
      fieldIdent: '00070',
      role: 'manager',
      subjectKind: 'person',
      entryNumber: '20080103090000',
    });
    expect(persons).toEqual([
      { indent: hash('a'), name: 'ИМЕ ЕДНО', indentType: 'EGN' },
      { indent: hash('b'), name: 'ИМЕ ДВЕ', indentType: 'EGN' },
    ]);
  });

  it('ends every role of a field at an Erase, which carries no records, and opens a new one for a holder who returns', () => {
    const partners = (...cs: string[]) => ({
      Partner: cs.map((c, i) => ({
        RecordID: String(i + 1),
        share: '100',
        Subject: person(c, `СЪДРУЖНИК ${c}`),
      })),
    });
    const { roles } = rolesFromDeed(
      '101010101',
      partida(
        on('2010-01-01', { fieldIdent: '00190', element: 'Partners', value: partners('1', '2') }),
        on('2012-05-05', {
          fieldIdent: '00190',
          element: 'Partners',
          operation: 'Erase',
          value: '',
        }),
        on('2014-09-09', { fieldIdent: '00190', element: 'Partners', value: partners('2') }),
      ),
    );
    expect(roles.map((r) => [r.subjectId, r.addedOn, r.removedOn])).toEqual([
      [hash('1'), '2010-01-01', '2012-05-05'],
      [hash('2'), '2010-01-01', '2012-05-05'],
      [hash('2'), '2014-09-09', null],
    ]);
  });

  it('keeps the entry that added a holder who stays, and what the latest entry says of them', () => {
    const partner = (share: string, name: string) => ({
      Partner: [{ RecordID: '1', share, currency: 'BGN', Subject: person('3', name) }],
    });
    const { roles, persons } = rolesFromDeed(
      '101010101',
      partida(
        on('2011-01-01', { fieldIdent: '00190', value: partner('5000', 'ИМЕ ПО СТАРОМУ') }),
        on('2016-01-01', { fieldIdent: '00190', value: partner('7000', 'ИМЕ ПО НОВОМУ') }),
      ),
    );
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({
      addedOn: '2011-01-01',
      entryNumber: '20110101090000',
      removedOn: null,
      share: '7000 BGN',
      subjectName: 'ИМЕ ПО НОВОМУ',
    });
    expect(persons).toEqual([{ indent: hash('3'), name: 'ИМЕ ПО НОВОМУ', indentType: 'EGN' }]);
  });

  it('follows each field of each sub-partida on its own', () => {
    const { roles } = rolesFromDeed(
      '101010101',
      partidaOf(
        {
          subUic: '0000',
          fields: [
            on('2010-01-01', { value: managers(['4', 'УПРАВИТЕЛ']) }),
            on('2010-01-01', {
              fieldIdent: '00190',
              element: 'Partners',
              value: { Partner: [{ RecordID: '1', Subject: person('4', 'УПРАВИТЕЛ') }] },
            }),
          ],
        },
        {
          subUic: '0001',
          fields: [
            on('2012-01-01', {
              fieldIdent: '00530',
              element: 'BranchManagers',
              value: { BranchManager: [{ RecordID: '1', Person: person('5', 'КЛОН') }] },
            }),
            on('2013-01-01', {
              fieldIdent: '00530',
              element: 'BranchManagers',
              operation: 'Erase',
              value: '',
            }),
          ],
        },
      ),
    );
    expect(roles.map((r) => [r.subUic, r.role, r.subjectId, r.removedOn])).toEqual([
      ['0000', 'manager', hash('4'), null],
      ['0000', 'partner', hash('4'), null],
      ['0001', 'branch_manager', hash('5'), '2013-01-01'],
    ]);
  });

  it('reads an actual owner: the person, the country of residence, the size of each owned right — never the address', () => {
    const owner = (over: Record<string, unknown>) => ({
      RecordID: '7',
      GroupID: '1',
      Person: person('c', 'СОБСТВЕНИК'),
      ...over,
    });
    const { roles } = rolesFromDeed(
      '101010101',
      partida(
        field({
          fieldIdent: '05500',
          element: 'ActualOwners',
          value: {
            ActualOwner: [
              owner({
                CountryOfResidence: { Country: 'БЪЛГАРИЯ', CountryCode: 'BG', IsForeign: 'false' },
                Address: { Settlement: 'СОФИЯ', Street: 'УЛИЦА' },
                OwnedRights: 'пряко',
                OwnedRightsDetails: {
                  OwnedRightsDetail: [
                    { OwnedRightCode: '1', OwnedRightSize: '60' },
                    { OwnedRightSize: '40' },
                  ],
                },
              }),
              owner({
                RecordID: '8',
                Person: { ...person('d', 'ДРУГ'), CountryName: 'ГЪРЦИЯ' },
                OwnedRights: 'непряко',
              }),
            ],
          },
        }),
      ),
    );
    expect(roles.map((r) => [r.role, r.share, r.country])).toEqual([
      ['beneficial_owner', '60; 40', 'БЪЛГАРИЯ'],
      ['beneficial_owner', 'непряко', 'ГЪРЦИЯ'],
    ]);
    expect(JSON.stringify(roles)).not.toContain('УЛИЦА');
  });

  it('reads a partner’s share with its currency, a single partner that comes as an object, and numbers as text', () => {
    const subject = (over: Record<string, unknown>) => ({
      Indent: hash('e'),
      IndentType: 'EGN',
      Name: 'СЪДРУЖНИК',
      CountryName: 'БЪЛГАРИЯ',
      LegalForm: '',
      ...over,
    });
    const { roles } = rolesFromDeed(
      '101010101',
      partida(
        field({
          fieldIdent: '00190',
          element: 'Partners',
          value: {
            Partner: [{ RecordID: '1', share: '5000', currency: 'BGN', Subject: subject({}) }],
          },
        }),
        field({
          fieldIdent: '00210',
          element: 'LimitedLiabilityPartners',
          value: {
            LimitedLiabilityPartner: {
              RecordID: 2,
              share: 10,
              Subject: subject({ Indent: hash('f') }),
            },
          },
        }),
      ),
    );
    expect(roles.map((r) => [r.role, r.subjectId, r.share, r.country])).toEqual([
      ['partner', hash('e'), '5000 BGN', 'БЪЛГАРИЯ'],
      ['partner', hash('f'), '10', 'БЪЛГАРИЯ'],
    ]);
  });

  it('reads a single record the same whether it comes as an object or as a list of one', () => {
    // The API is moving every such container to a list; until it has, a lone record may still come bare.
    const rec = { RecordID: '1', share: '10', Subject: person('e', 'СЪДРУЖНИК') };
    const read = (value: unknown) =>
      rolesFromDeed('101010101', partida(field({ fieldIdent: '00210', value }))).roles;
    expect(read({ LimitedLiabilityPartner: rec })).toEqual(
      read({ LimitedLiabilityPartner: [rec] }),
    );
    expect(read({ LimitedLiabilityPartner: [rec] })).toHaveLength(1);
  });

  it('knows a person only by the register’s hash, and an entity by its ЕИК', () => {
    const { roles, persons } = rolesFromDeed(
      '101010101',
      partida(
        field({
          fieldIdent: '00190',
          element: 'Partners',
          value: {
            Partner: [
              {
                RecordID: '1',
                Subject: {
                  Name: 'ИВАН ПЕТРОВ И ПЕТЪР ИВАНОВ ООД',
                  Indent: '202020202',
                  IndentType: 'UIC',
                },
              },
              {
                RecordID: '2',
                Subject: { Name: 'ЛИЦЕ', Indent: hash('9'), IndentType: 'BirthDate' },
              },
              {
                RecordID: '3',
                Subject: {
                  Name: 'ЧУЖДА ФИРМА ГМБХ',
                  Indent: 'HRB 1234',
                  IndentType: 'Undefined',
                  LegalForm: 'GMBH',
                },
              },
              {
                RecordID: '4',
                Subject: { Name: 'Чужденец', Indent: '1980-01-01', IndentType: 'Undefined' },
              },
              { RecordID: '5', Subject: { Name: 'БЕЗ НОМЕР', Indent: '', IndentType: 'EGN' } },
            ],
          },
        }),
      ),
    );
    expect(roles.map((r) => [r.subjectKind, r.subjectId])).toEqual([
      ['entity', '202020202'],
      ['person', `local:101010101:birthdate:${hash('9')}:ЛИЦЕ`],
      ['entity', 'name:ЧУЖДА ФИРМА ГМБХ'],
      ['person', 'local:101010101:ЧУЖДЕНЕЦ'],
      ['person', 'local:101010101:БЕЗ НОМЕР'],
    ]);
    // A birth date is not a unique personal number, even when hashed.
    expect(persons).toEqual([]);
  });

  it('keeps names and companies separate when the register only supplies a birth date', () => {
    const deed = (name: string) =>
      partida(
        field({
          fieldIdent: '00070',
          value: {
            Manager: {
              RecordID: '1',
              Person: { Name: name, Indent: hash('9'), IndentType: 'BirthDate' },
            },
          },
        }),
      );
    const a = rolesFromDeed('101010101', deed('Иван Петров'));
    const b = rolesFromDeed('202020202', deed('Иван Петров'));
    const c = rolesFromDeed('101010101', deed('Петър Иванов'));
    expect(new Set([a, b, c].map((r) => r.roles[0]!.subjectId)).size).toBe(3);
    for (const result of [a, b, c]) {
      expect(result.persons).toEqual([]);
      expect(result.observations[0]).toMatchObject({
        kind: 'other',
        indent: null,
        indentType: 'BirthDate',
      });
    }
  });

  it('reads a single-record field, and passes over fields and records that name no holder', () => {
    const { roles } = rolesFromDeed(
      '101010101',
      partida(
        field({
          fieldIdent: '00230',
          element: 'SoleCapitalOwner',
          value: {
            RecordID: '5',
            Subject: { Name: 'ЕДНОЛИЧЕН', Indent: hash('5'), IndentType: 'EGN' },
          },
        }),
        field({
          fieldIdent: '00020',
          element: 'Company',
          value: { RecordID: '6', $text: 'ПРИМЕР ЕООД' },
        }),
        field({
          fieldIdent: '00100',
          value: { Representative: [{ GroupID: '1', Person: person('6', 'БЕЗ ЗАПИС') }] },
        }),
        field({
          fieldIdent: '00410',
          value: { Procurator: [{ RecordID: '8', Person: { Indent: hash('7') } }] },
        }),
      ),
    );
    expect(roles.map((r) => [r.role, r.subjectId])).toEqual([['sole_owner', hash('5')]]);
  });

  it('names every holder of a record that carries more than one', () => {
    const { roles } = rolesFromDeed(
      '101010101',
      partida(
        field({
          fieldIdent: '00190',
          value: {
            Partner: {
              RecordID: '9',
              Subject: [
                { Name: 'ПЪРВИ', Indent: hash('1'), IndentType: 'EGN' },
                { Name: 'ВТОРИ', Indent: hash('2'), IndentType: 'LNCH' },
              ],
            },
          },
        }),
      ),
    );
    expect(roles.map((r) => r.subjectId)).toEqual([hash('1'), hash('2')]);
  });

  it('takes the holder, not a person nested under it', () => {
    const { roles } = rolesFromDeed(
      '101010101',
      partida(
        field({
          fieldIdent: '00120',
          element: 'BoardOfDirectors',
          value: {
            Director: [
              {
                RecordID: '11',
                Subject: { Name: 'ЧЛЕН АД', Indent: '303030303', IndentType: 'UIC' },
                Representative: { Person: person('8', 'ПРЕДСТАВЛЯВАЩ') },
              },
            ],
          },
        }),
      ),
    );
    expect(roles.map((r) => [r.role, r.subjectKind, r.subjectId])).toEqual([
      ['board_of_directors', 'entity', '303030303'],
    ]);
  });

  it('reads the same role under the field each legal form files it under', () => {
    const one = (fieldIdent: string, value: unknown) =>
      rolesFromDeed('101010101', partida(field({ fieldIdent, value }))).roles.map((r) => r.role);
    const rec = (c: string) => ({ RecordID: c, Person: person(c, `ЛИЦЕ ${c}`) });
    expect(one('00071', { AssignedManager: [rec('1')] })).toEqual(['manager']);
    expect(one('00103', { Representative103: [rec('2')] })).toEqual(['representative']);
    expect(one('00125', { ManagementBody12d: [rec('3')] })).toEqual(['governing_body']);
    expect(one('00132', { BoardOfManager2: [rec('4')] })).toEqual(['management_board']);
    expect(one('00135', { BoardOfTrustie13g: [rec('5')] })).toEqual(['board_of_trustees']);
    expect(one('00152', { VerificationCommission: [rec('6')] })).toEqual([
      'verification_commission',
    ]);
    expect(
      one('00201', { Partner: [{ RecordID: '7', Subject: person('7', 'СЪДРУЖНИК') }] }),
    ).toEqual(['partner']);
    expect(one('09122', { Trustee: [rec('8')] })).toEqual(['trustee']);
    // A share transfer names people too, but records a transaction, not a role.
    expect(
      one('00240', { ShareTransfer: [{ RecordID: '9', OldOwner: person('9', 'ПРОДАВАЧ') }] }),
    ).toEqual([]);
  });

  it('maps every role field it knows to a role', () => {
    expect(ROLE_FIELDS['05500']).toBe('beneficial_owner');
    expect(Object.values(ROLE_FIELDS).length).toBeGreaterThan(15);
  });
});

describe('deedFacts', () => {
  const seat = (d: string, settlement: string, over: Partial<RegistryField> = {}) =>
    on(d, {
      fieldIdent: '00050',
      element: 'Seat',
      value: {
        RecordID: '1',
        Address: {
          Country: 'БЪЛГАРИЯ',
          Settlement: settlement,
          Street: 'ул. ТАЙНА',
          StreetNumber: '7',
        },
        Contacts: { Phone: '02/000' },
      },
      ...over,
    });

  it('reads the seat as it stands — the settlement and the day it was registered, nothing else of the address', () => {
    const f = deedFacts(partida(seat('2008-02-06', 'гр. Варна'), seat('2013-05-23', 'гр. София')));
    expect(f).toMatchObject({ seatSettlement: 'гр. София', seatEntryOn: '2013-05-23' });
    expect(JSON.stringify(f)).not.toContain('ТАЙНА');
  });

  it('knows no seat once the field is erased, and none from a branch', () => {
    const erased = deedFacts(
      partida(
        seat('2008-02-06', 'гр. Варна'),
        seat('2010-01-01', '', { operation: 'Erase', value: '' }),
      ),
    );
    expect(erased).toMatchObject({ seatSettlement: null, seatEntryOn: null });
    const branch = partida(seat('2008-02-06', 'гр. Варна'));
    branch.deed.subDeeds[0]!.subUicType = 'B2_Branch';
    expect(deedFacts(branch).seatSettlement).toBeNull();
  });

  it('dates the ownership record by the latest entry of the ownership fields that stand', () => {
    const partner = { Partner: [{ RecordID: '1', Subject: person('1', 'СЪДРУЖНИК') }] };
    const f = deedFacts(
      partida(
        on('2010-01-01', { fieldIdent: '00190', value: partner }),
        on('2016-03-03', { fieldIdent: '00190', value: partner }),
        on('2012-02-02', {
          fieldIdent: '00230',
          value: { RecordID: '2', Subject: person('2', 'СОБСТВЕНИК') },
        }),
        // An erased field stands for nothing, however late its erasure.
        on('2018-04-04', { fieldIdent: '00230', operation: 'Erase', value: '' }),
        // Managers do not date the ownership record.
        on('2020-01-01', { value: managers(['3', 'УПРАВИТЕЛ']) }),
      ),
    );
    expect(f.ownersEntryOn).toBe('2016-03-03');
  });

  it('knows nothing of a partida that has neither', () => {
    expect(deedFacts(partida())).toEqual({
      seatSettlement: null,
      seatEntryOn: null,
      ownersEntryOn: null,
    });
  });
});

describe('identity observations', () => {
  it('does not turn different simultaneous holders sharing one hash into aliases', () => {
    const r = rolesFromDeed(
      '101010101',
      partida(
        on('2015-01-01', {
          value: managers(['a', 'ИВАН ПЕТРОВ ПЪРВИ', '1'], ['a', 'ПЕТЪР ИВАНОВ ВТОРИ', '2']),
        }),
      ),
    );
    expect(r.roles).toEqual([]);
    expect(r.observations.map((o) => o.kind)).toEqual(['collective', 'collective']);
  });
  it('keeps both exact names under one Indent without multiplying the timeline role', () => {
    const r = rolesFromDeed(
      '101010101',
      partida(
        on('2010-01-01', { value: managers(['a', 'ИВАНА ПЕТРОВА ПЪРВА', '1']) }),
        on('2015-01-01', { value: managers(['a', 'ИВАНА ПЕТРОВА ВТОРА', '2']) }),
      ),
    );
    expect(r.roles).toHaveLength(1);
    expect(r.observations.map((o) => [o.name, o.entryNumber, o.kind])).toEqual([
      ['ИВАНА ПЕТРОВА ПЪРВА', '20100101090000', 'person'],
      ['ИВАНА ПЕТРОВА ВТОРА', '20150101090000', 'person'],
    ]);
  });
  it('does not assign a collective name to one person or claim legal termination', () => {
    const r = rolesFromDeed(
      '101010101',
      partida(
        on('2010-01-01', { value: managers(['a', 'ИВАН ПЕТРОВ ПЪРВИ', '1']) }),
        on('2015-01-01', {
          value: managers([
            'a',
            'ИВАН ПЕТРОВ ПЪРВИ, ПЕТЪР ИВАНОВ ВТОРИ и МАРИЯ ИВАНОВА ТРЕТА',
            '2',
          ]),
        }),
      ),
    );
    expect(r.roles).toHaveLength(1);
    expect(r.roles[0]).toMatchObject({ removedOn: null, uncertainAfter: '2015-01-01' });
    expect(r.persons[0]?.name).toBe('ИВАН ПЕТРОВ ПЪРВИ');
    expect(r.observations[1]?.kind).toBe('collective');
  });
});

describe('registry shapes at the edges', () => {
  const one = (value: unknown, fieldIdent = '00070') =>
    rolesFromDeed('101010101', partida(field({ fieldIdent, value })));

  it('reads the text of an element that carries attributes, and skips one that has none', () => {
    const named = (RecordID: string, Name: unknown) => ({
      RecordID,
      Person: { ...person(RecordID, ''), Name },
    });
    const { roles, observations } = one({
      Manager: [
        named('1', { Lang: 'bg', $text: ' ИВАН ПЕТРОВ ' }),
        named('2', { Lang: 'bg', $text: '   ' }),
        named('3', { Lang: 'bg' }),
      ],
    });
    expect(roles.map((r) => [r.subjectId, r.subjectName])).toEqual([[hash('1'), 'ИВАН ПЕТРОВ']]);
    expect(observations.map((o) => o.name)).toEqual(['ИВАН ПЕТРОВ']);
  });

  it('keeps a hash the register gives without its IndentType inside the partida', () => {
    const { roles, persons, observations } = one({
      Manager: [{ RecordID: '1', Person: { Name: 'БЕЗ ВИД', Indent: hash('b') } }],
    });
    expect(roles.map((r) => [r.subjectKind, r.subjectId])).toEqual([
      ['person', 'local:101010101:БЕЗ ВИД'],
    ]);
    expect(persons).toEqual([]);
    expect(observations[0]).toMatchObject({ indent: null, indentType: null, kind: 'other' });
  });

  it('reads a lone owned right, skips empty ones and falls back to the rights text', () => {
    const owner = (c: string, over: Record<string, unknown>) => ({
      RecordID: c,
      Person: person(c, `СОБСТВЕНИК ${c}`),
      ...over,
    });
    const { roles } = one(
      {
        ActualOwner: [
          owner('1', { OwnedRightsDetails: { OwnedRightsDetail: { OwnedRightSize: '100' } } }),
          owner('2', {
            OwnedRights: 'непряко',
            OwnedRightsDetails: { OwnedRightsDetail: ['', { OwnedRightSize: 25 }] },
          }),
          owner('3', { OwnedRights: 'пряко', OwnedRightsDetails: { OwnedRightsDetail: [''] } }),
        ],
      },
      '05500',
    );
    expect(roles.map((r) => [r.subjectId, r.share])).toEqual([
      [hash('1'), '100'],
      [hash('2'), '25'],
      [hash('3'), 'пряко'],
    ]);
  });

  it('orders the entries of one moment by their entry number, whatever order they come in', () => {
    const at = (entryNumber: string, value: unknown) =>
      field({ entryNumber, entryDate: '2015-01-01T09:00:00', value });
    const { roles } = rolesFromDeed(
      '101010101',
      partida(
        at('20150101000002', managers(['b', 'ИМЕ ДВЕ'])),
        at('20150101000001', managers(['a', 'ИМЕ ЕДНО'])),
      ),
    );
    expect(roles.map((r) => [r.subjectId, r.entryNumber, r.addedOn, r.removedOn])).toEqual([
      [hash('a'), '20150101000001', '2015-01-01', '2015-01-01'],
      [hash('b'), '20150101000002', '2015-01-01', null],
    ]);
  });

  const seatAt = (d: string, value: unknown, over: Partial<RegistryField> = {}) =>
    on(d, { fieldIdent: '00050', element: 'Seat', value, ...over });
  const address = (Settlement: string) => ({ RecordID: '1', Address: { Settlement } });

  it('lets the latest entry of the seat decide, whatever order the entries come in', () => {
    const f = deedFacts(
      partida(
        seatAt('2013-05-23', address('гр. София')),
        seatAt('2008-02-06', address('гр. Варна')),
        seatAt('2013-05-23', address('гр. Бургас'), { entryNumber: '20130523080000' }),
      ),
    );
    expect(f).toMatchObject({ seatSettlement: 'гр. София', seatEntryOn: '2013-05-23' });
  });

  it('dates a seat entry that carries no address, without inventing a settlement', () => {
    expect(deedFacts(partida(seatAt('2011-11-11', { RecordID: '1' })))).toEqual({
      seatSettlement: null,
      seatEntryOn: '2011-11-11',
      ownersEntryOn: null,
    });
  });

  it('dates the ownership record by the latest of several standing fields, in any order', () => {
    const partners = on('2016-03-03', {
      fieldIdent: '00190',
      value: { Partner: [{ RecordID: '1', Subject: person('1', 'СЪДРУЖНИК ЕДНО') }] },
    });
    const soleOwner = on('2012-02-02', {
      fieldIdent: '00230',
      value: { RecordID: '2', Subject: person('2', 'СОБСТВЕНИК ДВЕ') },
    });
    expect(deedFacts(partida(partners, soleOwner)).ownersEntryOn).toBe('2016-03-03');
    expect(deedFacts(partida(soleOwner, partners)).ownersEntryOn).toBe('2016-03-03');
  });
});
