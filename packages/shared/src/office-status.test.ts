import { describe, expect, it } from 'vitest';
import {
  describeOffices,
  officePeriodsText,
  officeStatusText,
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
    expect(officeStatusText(office!)).toBe('Бивш: декларация при освобождаване за 2021 г.');
    expect(officePeriodsText(office!)).toBe('2019–2021');
  });

  it('without an exit declaration says only the last year on record — never „настоящ"', () => {
    const [office] = describeOffices(
      [f('2021', 'Entry', '2021-02-01'), f('2021', 'Annualy'), f('2022', 'Annualy')],
      2026,
    );
    expect(office!.status).toEqual({ kind: 'unknown', lastYear: '2022' });
    expect(officeStatusText(office!)).toBe('Последна декларация за 2022 г.');
    expect(officeStatusText(office!)).not.toMatch(/настоящ/i);
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
      ['Община Тестово', { kind: 'former', year: '2016' }],
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
    expect(officeStatusText(undated!)).toBeNull();
  });
});
