import { describe, expect, it } from 'vitest';
import {
  describeOffices,
  officeLine,
  officePeriodsText,
  officeTitle,
  officeYearsText,
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

describe('describeOffices', () => {
  it('calls an office former only with an exit declaration that nothing reopens', () => {
    const [office] = describeOffices(
      [
        f('2019', 'Entry', '2019-11-20'),
        f('2019', 'Annualy', '2020-05-10'),
        f('2020', 'Annualy', '2021-05-10'),
        f('2021', 'Vacate', '2021-03-01'),
        // The annual filing for the year of leaving, filed after the exit, does not reopen the office.
        f('2021', 'Annualy', '2022-05-10'),
      ],
      2026,
    );
    expect(office!.status).toEqual({ kind: 'former', year: '2021' });
    expect(officeLine(office!)).toBe('Бивш кмет · Община Тестово · 2019–2021');
    expect(officePeriodsText(office!)).toBe('2019–2021');
  });

  it('without an exit declaration says only the last year on record — never „настоящ"', () => {
    const [office] = describeOffices(
      [f('2021', 'Entry', '2021-02-01'), f('2021', 'Annualy'), f('2022', 'Annualy')],
      2026,
    );
    expect(office!.status).toEqual({ kind: 'unknown', lastYear: '2022' });
    expect(officeLine(office!)).toBe('Кмет · Община Тестово · декларации за 2021–2022');
    expect(officeLine(office!)).not.toMatch(/настоящ|бивш/i);
  });

  it('keeps a repeated period separate and judges only the latest one', () => {
    const [office] = describeOffices(
      [
        f('2012', 'Entry'),
        f('2013', 'Annualy'),
        f('2014', 'Vacate', '2014-06-01'),
        f('2017', 'Entry', '2017-04-01'),
        f('2018', 'Annualy'),
      ],
      2026,
    );
    expect(office!.periods).toEqual([
      { spans: [['2012', '2014']], ended: true },
      { spans: [['2017', '2018']], ended: false },
    ]);
    expect(officePeriodsText(office!)).toBe('2012–2014; 2017–2018');
    expect(office!.status).toEqual({ kind: 'unknown', lastYear: '2018' });
  });

  it('a re-entry dated after the exit in the same year reopens the office and starts a new period', () => {
    const [office] = describeOffices(
      [
        f('2018', 'Annualy'),
        f('2019', 'Vacate', '2019-03-01'),
        f('2019', 'Entry', '2019-11-15'),
        f('2020', 'Annualy'),
      ],
      2026,
    );
    expect(office!.status.kind).toBe('unknown');
    expect(officePeriodsText(office!)).toBe('2018–2019; 2019–2020');
  });

  it('an undated or same-day entry beside the exit leaves the end unestablished', () => {
    for (const entryOn of [null, '2019-11-01']) {
      const [office] = describeOffices(
        [f('2019', 'Vacate', '2019-11-01'), f('2019', 'Entry', entryOn)],
        2026,
      );
      expect(office!.status).toEqual({ kind: 'unknown', lastYear: '2019' });
    }
    // An entry dated before the exit is the start of the same period, not a reopening.
    const [closed] = describeOffices(
      [f('2019', 'Entry', '2019-01-10'), f('2019', 'Vacate', '2019-11-01')],
      2026,
    );
    expect(closed!.status).toEqual({ kind: 'former', year: '2019' });
  });

  it('two institutions are two offices with their own status, most recent first', () => {
    const offices = describeOffices(
      [
        f('2015', 'Annualy', null, 'Община Тестово', 'общински съветник'),
        f('2016', 'Vacate', '2016-02-01', 'Общински съвет Тестово', 'общински съветник'),
        f('2016', 'Entry', '2016-03-01', 'Министерство на тестовете', 'заместник-министър'),
        f('2017', 'Annualy', null, 'Министерство на тестовете', 'заместник-министър'),
      ],
      2026,
    );
    expect(offices.map((o) => [o.institution, o.status])).toEqual([
      ['Министерство на тестовете', { kind: 'unknown', lastYear: '2017' }],
      // One filing each way: on a tie the longer spelling is shown.
      ['Общински съвет Тестово', { kind: 'former', year: '2016' }],
    ]);
  });

  it('a later filing in the same institution, under another position, keeps the office open', () => {
    const [office] = describeOffices(
      [
        f('2015', 'Vacate', '2015-11-01', 'Община Тестово', 'заместник-кмет'),
        f('2016', 'Annualy', null, 'Община Тестово', 'кмет'),
      ],
      2026,
    );
    expect(office!.positions).toEqual(['заместник-кмет', 'кмет']);
    expect(office!.status).toEqual({ kind: 'unknown', lastYear: '2016' });
  });

  it('never fills a gap between filed years, and ignores years after the current one', () => {
    const [office] = describeOffices(
      [f('2014', 'Annualy'), f('2015', 'Annualy'), f('2018', 'Annualy'), f('2099', 'Entry')],
      2026,
    );
    expect(officePeriodsText(office!)).toBe('2014–2015, 2018');
    expect(office!.status).toEqual({ kind: 'unknown', lastYear: '2018' });
  });

  it('counts duplicate filings once and keeps an office known only by name as undated', () => {
    const twice = [f('2020', 'Vacate', '2020-05-01'), f('2020', 'Vacate', '2020-05-01')];
    expect(describeOffices(twice, 2026)[0]!.status).toEqual({ kind: 'former', year: '2020' });
    const [undated] = describeOffices(
      [{ institution: 'Агенция за тестове', position: 'директор', year: null }],
      2026,
    );
    expect(undated!.status).toEqual({ kind: 'undated' });
    expect(officeYearsText(undated!)).toBeNull();
    expect(officeLine(undated!)).toBe('Директор · Агенция за тестове');
  });
});

describe('sharedOfficeYears', () => {
  const [office] = describeOffices(
    [
      f('2014', 'Annualy'),
      f('2015', 'Annualy'),
      f('2018', 'Annualy'),
      f('2019', 'Vacate', '2019-04-01'),
    ],
    2026,
  );
  it('gives the office years in which the role was in force, and no filled gap', () => {
    expect(sharedOfficeYears(office!, '2015-06-01', '2018-02-01')).toEqual(['2015', '2018']);
    expect(yearsText(sharedOfficeYears(office!, '2010-01-01', null, 2026))).toBe(
      '2014–2015, 2018–2019',
    );
  });
  it('shares nothing when the role lies outside the years with filings', () => {
    expect(sharedOfficeYears(office!, '2020-01-01', null, 2026)).toEqual([]);
    expect(sharedOfficeYears(office!, '2016-01-01', '2017-12-31')).toEqual([]);
  });
});

describe('officesLine', () => {
  it('names the latest office with „бивш" only when the rule allows, its years and how many more', () => {
    const offices = describeOffices(
      [
        f('2015', 'Annualy', null, 'Община Тестово', 'кмет'),
        f('2019', 'Vacate', '2019-11-01', 'Община Тестово', 'кмет'),
        f('2012', 'Annualy', null, 'Агенция за тестове', 'директор'),
      ],
      2026,
    );
    expect(officesLine(offices)).toBe('Бивш кмет · Община Тестово · 2015, 2019 · още 1 длъжност');
    expect(officesLine(describeOffices([f('2023', 'Annualy')], 2026))).toBe(
      'Кмет · Община Тестово · декларация за 2023',
    );
    expect(officesLine([])).toBeNull();
  });
});

describe('the words of one office', () => {
  const former = (position: string | null): string | null =>
    officeTitle(
      describeOffices(
        [{ institution: 'Агенция за тестове', position, year: '2020', type: 'Vacate' }],
        2026,
      )[0]!,
    );

  it('puts „Бивш" in front of the position, agreeing with it, and sets capitals in sentence case', () => {
    expect(former('Общински съветник')).toBe('Бивш общински съветник');
    expect(former('ОБЩИНСКИ СЪВЕТНИК')).toBe('Бивш общински съветник');
    expect(former('ИД директор')).toBe('Бивш ИД директор');
    expect(former('Главна счетоводителка')).toBe('Бивша главна счетоводителка');
    expect(former('Упълномощено лице')).toBe('Бивше упълномощено лице');
    expect(former(null)).toBe('Бивша длъжност');
  });

  it('lists several positions once, the status in front of the first', () => {
    const [office] = describeOffices(
      [
        f('2015', 'Annualy', null, 'Община Тестово', 'Заместник-кмет'),
        f('2016', 'Vacate', '2016-11-01', 'Община Тестово', 'Кмет'),
      ],
      2026,
    );
    expect(officeLine(office!)).toBe('Бивш заместник-кмет, кмет · Община Тестово · 2015–2016');
  });
});

describe('one office under two spellings', () => {
  it('reads a council filed under its abbreviation and under its municipality as ONE former office', () => {
    // The annual filing spells the body by its initials, the entry and the exit name the municipality: apart,
    // the exit would close one spelling and leave the other reading as an open office.
    const offices = describeOffices(
      [
        f('2023', 'Entry', '2023-11-13', 'Столична община', 'Общински съветник'),
        f('2023', 'Annualy', '2024-02-01', 'СОС', 'Общински съветник'),
        f('2024', 'Vacate', '2024-02-09', 'Столична община', 'Общински съветник'),
      ],
      2026,
    );
    expect(offices).toHaveLength(1);
    expect(officeLine(offices[0]!)).toBe('Бивш общински съветник · Столична община · 2023–2024');
    expect(offices[0]!.spellings).toEqual(['Столична община', 'СОС']);
    // The council in full, with a typing error in one filing, is still the same office.
    expect(
      describeOffices(
        [
          f('2020', 'Annualy', null, 'Столичен общински съвет', 'Общински съветник'),
          f('2021', 'Annualy', null, 'Столичен общински съвет', 'Общински съветник'),
          f('2022', 'Annualy', null, 'Столичен общинскии съвет', 'Общински съветник'),
          f('2023', 'Vacate', '2023-11-10', 'Столична община', 'Общински съветник'),
        ],
        2026,
      ).map(officeLine),
    ).toEqual(['Бивш общински съветник · Столичен общински съвет · 2020–2023']);
  });

  it('joins an abbreviation, a typing error and a bare council to the body they stand for', () => {
    const one = (a: string, b: string): number =>
      describeOffices(
        [f('2019', 'Annualy', null, a, 'член'), f('2020', 'Annualy', null, b, 'член')],
        2026,
      ).length;
    expect(one('Агенция за тестове и проверки', 'АТП')).toBe(1);
    expect(one('Министерство на тестовете', 'Министрество на тестовете')).toBe(1);
    expect(one('Община Тестово', 'Общински съвет')).toBe(1);
    expect(one('Тестова компания ЕАД', 'Тестова компания ЕАД гр. Тестово')).toBe(1);
    expect(one('В.Ф. 12345', 'Военно формирование 12345')).toBe(1);
    expect(one('44-то НС', 'Народно събрание')).toBe(1);
  });

  it('keeps two bodies apart: other names, other numbers, another position or years that do not touch', () => {
    const count = (filings: OfficeFiling[]): number => describeOffices(filings, 2026).length;
    // Two boards somebody sits on at once share a position and years, not a name.
    expect(
      count([
        f('2019', 'Annualy', null, 'Тестова компания ЕАД', 'член на съвета на директорите'),
        f('2019', 'Annualy', null, 'Пробен холдинг ЕАД', 'член на съвета на директорите'),
      ]),
    ).toBe(2);
    // A unit is told apart by its number.
    expect(
      count([
        f('2019', 'Annualy', null, 'В.Ф. 12345', 'командир'),
        f('2020', 'Annualy', null, 'В.Ф. 12346', 'командир'),
      ]),
    ).toBe(2);
    // Like names, another position: a court and the council of the same town.
    expect(
      count([
        f('2019', 'Annualy', null, 'ОС Тестово', 'съдия'),
        f('2019', 'Annualy', null, 'Община Тестово', 'общински съветник'),
      ]),
    ).toBe(2);
    // An oblast's administration and the municipality of its town.
    expect(
      count([
        f('2019', 'Annualy', null, 'Областна администрация Тестово', 'експерт'),
        f('2019', 'Annualy', null, 'Община Тестово', 'експерт'),
      ]),
    ).toBe(2);
    // The same spelling pair years apart is not read as one office.
    expect(
      count([
        f('2012', 'Annualy', null, 'Агенция за тестове и проверки', 'директор'),
        f('2020', 'Annualy', null, 'АТП', 'директор'),
      ]),
    ).toBe(2);
  });

  it('a filing that lists two bodies does not join them to each other', () => {
    const offices = describeOffices(
      [
        f('2019', 'Annualy', null, 'Съвет за тестове', 'член'),
        f('2019', 'Annualy', null, 'Съвет за тестове, Агенция за проверки', 'член'),
        f('2019', 'Annualy', null, 'Агенция за проверки', 'член'),
      ],
      2026,
    );
    expect(offices.length).toBe(2);
    expect(sameBodySpelling('ОБЛАСТ ТЕСТОВО', 'ТЕСТОВО / ПРОБНО')).toBe(false);
  });
});
