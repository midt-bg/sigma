import { describe, expect, it } from 'vitest';
import {
  describeOffices,
  officeLine,
  officePeriodsText,
  officeTitle,
  officesLine,
  sameBodySpelling,
  sharedOfficeYears,
  yearsText,
  type OfficeFiling,
} from './office-status';

const f = (
  year: string,
  type: string,
  declaredOn: string | null = null,
  institution = 'Община Тестово',
  position = 'кмет',
): OfficeFiling => ({ institution, position, year, type, declaredOn });

describe('the edges of the rule', () => {
  it('takes the latest of several exit declarations in one year, dated or not', () => {
    const exits = (days: (string | null)[], institution: string): OfficeFiling[] => [
      f('2020', 'Annualy', null, institution),
      ...days.map((day) => f('2021', 'Vacate', day, institution)),
    ];
    const offices = describeOffices(
      [
        ...exits([null, '2021-03-01', '2021-06-01'], 'Община Тестово'),
        ...exits(['2021-06-01', null, '2021-03-01'], 'Община Пробно'),
      ],
      2026,
    );
    expect(offices.map((o) => [o.status, o.exitOn])).toEqual([
      [{ kind: 'former', year: '2021' }, '2021-06-01'],
      [{ kind: 'former', year: '2021' }, '2021-06-01'],
    ]);
  });

  it('skips a filing with no institution and keeps a position that is only a mark', () => {
    const offices = describeOffices(
      [
        { institution: null, position: 'кмет', year: '2020', type: 'Annualy' },
        { institution: '  ', position: 'кмет', year: '2020', type: 'Annualy' },
        f('2020', 'Annualy', null, 'Община Тестово', '—'),
      ],
      2026,
    );
    expect(offices.map((o) => [o.institution, o.positions])).toEqual([['Община Тестово', ['—']]]);
  });

  it('an office with no position on record has no title unless it is former', () => {
    const [office] = describeOffices([f('2020', 'Annualy', null, 'Община Тестово', '')], 2026);
    expect(officeTitle(office!)).toBeNull();
    expect(officeLine(office!)).toBe('Община Тестово · последна декларация за 2020');
  });

  it('lists an office known only by name after the dated ones', () => {
    const offices = describeOffices(
      [
        { institution: 'Агенция Пробна', position: 'директор', year: null },
        { institution: 'Агенция Изпитна', position: 'експерт', year: null },
        f('2020', 'Annualy'),
      ],
      2026,
    );
    expect(offices.map((o) => [o.institution, o.status.kind])).toEqual([
      ['Община Тестово', 'unknown'],
      ['Агенция Изпитна', 'undated'],
      ['Агенция Пробна', 'undated'],
    ]);
    expect(officesLine(offices)).toBe(
      'Кмет · Община Тестово · последна декларация за 2020 · още 2 длъжности',
    );
  });

  it('joining two spellings keeps the positions of both', () => {
    const [office, ...rest] = describeOffices(
      [
        f('2019', 'Annualy', null, 'Общински съвет', 'общински съветник'),
        f('2020', 'Annualy', null, 'Община Тестово', 'общински съветник'),
        f('2020', 'Annualy', null, 'Община Тестово', 'председател на комисия'),
      ],
      2026,
    );
    expect(rest).toEqual([]);
    expect(office!.positions).toEqual(['общински съветник', 'председател на комисия']);
    expect(officePeriodsText(office!)).toBe('2019–2020');
  });

  it('reads one year as a year and a role with no usable date as sharing none', () => {
    expect(yearsText(['2021'])).toBe('2021');
    const [office] = describeOffices([f('2020', 'Annualy')], 2026);
    expect(sharedOfficeYears(office!, 'няма дата', null, 2026)).toEqual([]);
  });
});

describe('sameBodySpelling at its edges', () => {
  it('joins the same key, a bare council or oblast administration, a lost space and a short typing error', () => {
    expect(sameBodySpelling('ОБЩИНА ТЕСТОВО', 'ОБЩИНА ТЕСТОВО')).toBe(true);
    expect(sameBodySpelling('ОБЩИНСКИ СЪВЕТ', 'ОБЩИНА ТЕСТОВО')).toBe(true);
    expect(sameBodySpelling('ОБЛАСТНА АДМИНИСТРАЦИЯ', 'ОБЛАСТ ТЕСТОВО')).toBe(true);
    expect(sameBodySpelling('ОБЛАСТ ТЕСТОВО', 'ОБЛАСТНА АДМИНИСТРАЦИЯ')).toBe(true);
    expect(sameBodySpelling('ТЕСТ УСЛУГИ ЕООД', 'ТЕСТ УСЛУГИЕООД')).toBe(true);
    expect(sameBodySpelling('ДИРЕКЦИЯ ТЕСТО', 'ДИРЕКЦИЯ ТЕСТА')).toBe(true);
  });

  it('keeps apart a name with no naming word, initials that fit nothing and initials beside another place', () => {
    expect(sameBodySpelling('ГРАД', 'ОБЩИНА ТЕСТОВО')).toBe(false);
    expect(sameBodySpelling('АБВ ТЕСТ', 'ГОЛЯМА ДРУГА ТРЕТА ТЕСТ')).toBe(false);
    expect(sameBodySpelling('НС ТЕСТОВО', 'НАРОДНО СЪБРАНИЕ ДРУГОВО')).toBe(false);
  });
});
