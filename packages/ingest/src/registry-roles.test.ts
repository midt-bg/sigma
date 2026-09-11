// The partida-to-roles mapper, on records in the register's real shapes (fictional values): a role field is
// entries of records, an Erase entry strikes records by their RecordID, and a record carries its holder as a
// Person or a Subject — Indent, IndentType, Name, country, legal form — with the share beside it.
import { describe, expect, it } from 'vitest';
import type { RegistryDeed, RegistryField } from './registry';
import { ROLE_FIELDS, rolesFromDeed } from './registry-roles';

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
const partida = (...fields: RegistryField[]): RegistryDeed => {
  const body = {
    uic: '101010101',
    name: 'ПРИМЕР ЕООД',
    status: 'N',
    guid: 'g',
    legalForm: 'EOOD',
    subDeeds: [{ subUic: '0014', subUicType: 'MainCircumstances', status: 'A', fields }],
  };
  return { deed: body, deedActualState: body };
};
// The register's person hash is 64 hex characters.
const hash = (c: string) => c.repeat(64).slice(0, 64);
const person = (c: string, name: string) => ({ Indent: hash(c), IndentType: 'EGN', Name: name });

describe('rolesFromDeed', () => {
  it('reads a manager added by one entry and struck off by a later one', () => {
    const { roles, persons } = rolesFromDeed(
      '101010101',
      partida(
        field({
          value: { Manager: [{ RecordID: '6477', GroupID: '1', Person: person('a', 'ИМЕ ЕДНО') }] },
        }),
        field({
          operation: 'Erase',
          entryNumber: '20150601090000',
          entryDate: '2015-06-01T09:00:00',
          value: { Manager: [{ RecordID: '6477', GroupID: '1' }] },
        }),
        field({
          entryNumber: '20150601090000',
          entryDate: '2015-06-01T09:00:00',
          value: { Manager: [{ RecordID: '9001', GroupID: '2', Person: person('b', 'ИМЕ ДВЕ') }] },
        }),
      ),
    );
    expect(roles).toEqual([
      expect.objectContaining({
        recordId: '6477',
        role: 'manager',
        subjectKind: 'person',
        subjectId: hash('a'),
        addedOn: '2008-01-03',
        removedOn: '2015-06-01',
      }),
      expect.objectContaining({
        recordId: '9001',
        subjectId: hash('b'),
        addedOn: '2015-06-01',
        removedOn: null,
      }),
    ]);
    expect(persons).toEqual([
      { indent: hash('a'), name: 'ИМЕ ЕДНО', indentType: 'EGN' },
      { indent: hash('b'), name: 'ИМЕ ДВЕ', indentType: 'EGN' },
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

  it('reads a partner’s share with its currency, and a single partner that comes as an object', () => {
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
                Subject: { Name: 'ХОЛДИНГ АД', Indent: '202020202', IndentType: 'UIC' },
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
      ['person', hash('9')],
      ['entity', 'name:ЧУЖДА ФИРМА ГМБХ'],
      ['person', 'local:101010101:ЧУЖДЕНЕЦ'],
      ['person', 'local:101010101:БЕЗ НОМЕР'],
    ]);
    // Only the hashed one is a person across companies; the rest join nothing.
    expect(persons.map((p) => p.indent)).toEqual([hash('9')]);
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
          fieldIdent: '00070',
          value: { Manager: [{ GroupID: '1', Person: person('6', 'БЕЗ ЗАПИС') }] },
        }),
        field({
          fieldIdent: '00070',
          value: { Manager: [{ RecordID: '8', Person: { Indent: hash('7') } }] },
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

  it('maps every role field it knows to a role', () => {
    expect(ROLE_FIELDS['05500']).toBe('beneficial_owner');
    expect(Object.values(ROLE_FIELDS).length).toBeGreaterThan(15);
  });
});
