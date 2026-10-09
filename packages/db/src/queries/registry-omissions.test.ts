import { describe, expect, it } from 'vitest';
import { filingsByYear, historyNames, registryOmission } from './registry-omissions';

const company = { eik: '123456789', names: ['ТЕСТ ГРУП'] };

describe('registryOmission', () => {
  it('finds nothing to note when another filing of the same year names the company', () => {
    const byYear = filingsByYear([
      { year: '2023', eiks: [], named: ['Друга Фирма ООД'] },
      { year: '2023', eiks: [], named: ['ТЕСТ ГРУП ЕООД'] },
    ]);
    expect(registryOmission(byYear, '2023', company)).toBeNull();
  });

  it('gives no note for a year of which nothing was read, nor for a year without filings', () => {
    const byYear = filingsByYear([{ year: '2023', eiks: [], named: [] }]);
    expect(registryOmission(byYear, '2023', company)).toBeNull();
    expect(registryOmission(byYear, '2024', company)).toBeNull();
  });

  it('reports the latest earlier year whose filings name the company', () => {
    const byYear = filingsByYear([
      { year: '2019', eiks: ['123456789'], named: ['x'] },
      { year: '2021', eiks: [], named: ['ЕИК 123456789'] },
      { year: '2022', eiks: [], named: ['Друга Фирма ООД'] },
      { year: '2025', eiks: [], named: ['ТЕСТ ГРУП'] },
      { year: null, eiks: ['123456789'], named: ['ТЕСТ ГРУП'] },
    ]);
    expect(registryOmission(byYear, '2022', company)).toEqual({ earlierYear: '2021' });
  });

  it('notes a company named in no filing at all, with no earlier year', () => {
    const byYear = filingsByYear([{ year: '2022', eiks: [], named: ['Друга Фирма ООД'] }]);
    expect(registryOmission(byYear, '2022', company)).toEqual({ earlierYear: null });
  });
});

describe('historyNames', () => {
  it('reads the names a register history row records, whatever else it carries', () => {
    expect(
      historyNames('[{"name":"СТАРО ИМЕ","legalForm":"ООД"},"ДРУГО","",{"x":1},null]'),
    ).toEqual(['СТАРО ИМЕ', 'ДРУГО']);
  });

  it('names nothing from a missing, malformed or non-list history', () => {
    expect(historyNames(null)).toEqual([]);
    expect(historyNames('not json')).toEqual([]);
    expect(historyNames('{"name":"СТАРО ИМЕ"}')).toEqual([]);
  });
});
