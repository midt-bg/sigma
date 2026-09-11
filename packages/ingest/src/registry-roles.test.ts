// The partida-to-roles mapper, on records shaped as the API documents them: a role field is entries of
// records, an Erase entry strikes records by their RecordID, and a record carries a Person (the register's
// salted identifier and the name) or a Subject, with the share and country beside it in some fields.
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
const person = (indent: string, name: string) => ({
  Indent: indent,
  IndentType: 'EGN',
  Name: name,
});

describe('rolesFromDeed', () => {
  it('reads a manager added by one entry and struck off by a later one', () => {
    const { roles, persons } = rolesFromDeed(
      '101010101',
      partida(
        field({
          value: {
            Manager: [{ RecordID: '6477', GroupID: '1', Person: person('h1', 'ИМЕ ЕДНО') }],
          },
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
          value: { Manager: [{ RecordID: '9001', GroupID: '2', Person: person('h2', 'ИМЕ ДВЕ') }] },
        }),
      ),
    );
    expect(roles).toEqual([
      expect.objectContaining({
        recordId: '6477',
        role: 'manager',
        subjectKind: 'person',
        subjectId: 'h1',
        addedOn: '2008-01-03',
        removedOn: '2015-06-01',
      }),
      expect.objectContaining({
        recordId: '9001',
        subjectId: 'h2',
        addedOn: '2015-06-01',
        removedOn: null,
      }),
    ]);
    expect(persons).toEqual([
      { indent: 'h1', name: 'ИМЕ ЕДНО', indentType: 'EGN' },
      { indent: 'h2', name: 'ИМЕ ДВЕ', indentType: 'EGN' },
    ]);
  });

  it('reads an actual owner with the share and the country registered beside the person', () => {
    const { roles } = rolesFromDeed(
      '101010101',
      partida(
        field({
          fieldIdent: '05500',
          element: 'ActualOwners',
          value: {
            ActualOwner: [
              {
                RecordID: '7',
                Person: person('h3', 'СОБСТВЕНИК'),
                CountryName: 'БЪЛГАРИЯ',
                SharePercent: '60',
              },
            ],
          },
        }),
      ),
    );
    expect(roles).toEqual([
      expect.objectContaining({
        role: 'beneficial_owner',
        subjectId: 'h3',
        share: '60',
        country: 'БЪЛГАРИЯ',
      }),
    ]);
  });

  it('tells a company partner from a natural-person partner', () => {
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
              { RecordID: '2', Subject: { Name: 'ЛИЦЕ', Indent: 'h4', IndentType: 'EGN' } },
              { RecordID: '3', Subject: { Name: 'ЧУЖДА ФИРМА ГМБХ' } },
            ],
          },
        }),
      ),
    );
    expect(roles.map((r) => [r.subjectKind, r.subjectId])).toEqual([
      ['entity', '202020202'],
      ['person', 'h4'],
      ['entity', 'name:ЧУЖДА ФИРМА ГМБХ'],
    ]);
    expect(persons.map((p) => p.indent)).toEqual(['h4']);
  });

  it('reads a single-record field, and passes over fields that name no holder', () => {
    const { roles } = rolesFromDeed(
      '101010101',
      partida(
        field({
          fieldIdent: '00230',
          element: 'SoleCapitalOwner',
          value: { RecordID: '5', Subject: { Name: 'ЕДНОЛИЧЕН', Indent: 'h5', IndentType: 'EGN' } },
        }),
        field({
          fieldIdent: '00020',
          element: 'Company',
          value: { RecordID: '6', $text: 'ПРИМЕР ЕООД' },
        }),
        field({
          fieldIdent: '00070',
          value: { Manager: [{ GroupID: '1', Person: person('h6', 'БЕЗ ЗАПИС') }] },
        }),
        field({
          fieldIdent: '00070',
          value: { Manager: [{ RecordID: '8', Person: { Indent: 'h7' } }] },
        }),
      ),
    );
    expect(roles.map((r) => [r.role, r.subjectId])).toEqual([['sole_owner', 'h5']]);
  });

  it('names every holder of a transfer record', () => {
    const { roles } = rolesFromDeed(
      '101010101',
      partida(
        field({
          fieldIdent: '00190',
          value: {
            Partner: {
              RecordID: '9',
              Subject: [
                { Name: 'ПЪРВИ', Indent: 'a1', IndentType: 'EGN' },
                { Name: 'ВТОРИ', Indent: 'a2', IndentType: 'LNCH' },
              ],
            },
          },
        }),
      ),
    );
    expect(roles.map((r) => r.subjectId)).toEqual(['a1', 'a2']);
  });

  it('maps every role field it knows to a role', () => {
    expect(ROLE_FIELDS['05500']).toBe('beneficial_owner');
    expect(Object.values(ROLE_FIELDS).length).toBeGreaterThan(15);
  });
});
