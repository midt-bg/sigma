import { expect, test } from 'vitest';
import { parseRegistryXml } from './registry';
import { companyNamesFromDeed } from './registry-company-names';
const entry = (element: string, ident: string, date: string, content: string, op = 'Add') =>
  `<${element} FieldIdent="${ident}" FieldOperation="${op}" FieldEntryNumber="${date.replace(/\D/g, '')}" FieldEntryDate="${date}">${content}</${element}>`;
const name = (date: string, n: string, op = 'Add') => entry('Company', '00020', date, n, op);
const form = (date: string, n: string) => entry('LegalForm', '00030', date, `<Text>${n}</Text>`);
const parse = (fields: string) =>
  parseRegistryXml(
    `<DeedResult><Deed UIC="123456789"><SubDeed SubUIC="1" SubUICType="MainCircumstances">${fields}</SubDeed><SubDeed SubUIC="2" SubUICType="Branch">${name('2009-01-01T12:00:00', 'КЛОН')}</SubDeed></Deed><DeedActualState UIC="123456789"/></DeedResult>`,
    '123456789',
  );
test('historic names and forms are paired chronologically, never cross-joined', () => {
  const a = '2008-01-01T12:00:00',
    b = '2021-01-01T12:00:00',
    c = '2026-01-01T12:00:00';
  const r = companyNamesFromDeed(
    parse(
      form(c, 'Еднолично дружество с ограничена отговорност') +
        name(b, 'НОВО') +
        name(a, 'СТАРО') +
        form(a, 'Дружество с ограничена отговорност'),
    ),
  );
  expect(r.map((n) => [n.name, n.legalForm, n.from, n.until])).toEqual([
    ['СТАРО', 'ООД', a, b],
    ['НОВО', 'ООД', b, c],
    ['НОВО', 'ЕООД', c, null],
  ]);
  expect(r[1]!.nameEntry).toBe('20210101120000');
  expect(r[1]!.formEntry).toBe('20080101120000');
});
test('erased, unknown and contradictory fields do not invent aliases', () => {
  const a = '2008-01-01T12:00:00',
    b = '2021-01-01T12:00:00';
  const fields = name(a, 'ИМЕ') + form(a, 'Дружество с ограничена отговорност');
  expect(companyNamesFromDeed(parse(fields + name(b, '', 'Erase')))[0]!.until).toBe(b);
  expect(companyNamesFromDeed(parse(name(a, 'ИМЕ') + form(a, 'Непозната форма')))).toEqual([]);
  expect(companyNamesFromDeed(parse(fields + name(a, 'ДРУГО')))).toEqual([]);
});
