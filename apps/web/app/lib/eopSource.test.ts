import { describe, expect, it } from 'vitest';
import { eopSourceFiles } from './eopSource';

describe('eopSourceFiles', () => {
  it('returns [] for a missing date', () => {
    expect(eopSourceFiles(null)).toEqual([]);
    expect(eopSourceFiles(undefined)).toEqual([]);
    expect(eopSourceFiles('')).toEqual([]);
  });

  it('returns [] when the value is not a plain YYYY-MM-DD day', () => {
    expect(eopSourceFiles('not-a-date')).toEqual([]);
    expect(eopSourceFiles('2024/01/15')).toEqual([]);
  });

  it('builds the three base file links for a pre-OCDS day, keyed on DD.MM.YYYY', () => {
    const files = eopSourceFiles('2024-01-15');
    expect(files.map((f) => f.label)).toEqual(['Договори', 'Поръчки', 'Анекси']);
    expect(files[0]!.url).toContain('https://storage.eop.bg/open-data-2024-01-15/');
    // The Bulgarian noun and DD.MM.YYYY date are embedded (URL-encoded) in the object key.
    expect(decodeURIComponent(files[0]!.url)).toContain(
      'Автоматично генерирани данни за договори, публикувани в ЦАИС ЕОП на 15.01.2024.json',
    );
  });

  it('accepts a full ISO timestamp by slicing to the day', () => {
    const files = eopSourceFiles('2024-01-15T09:30:00Z');
    expect(files).toHaveLength(3);
    expect(files[0]!.url).toContain('open-data-2024-01-15');
  });

  it('appends the OCDS export on/after the 2026-01-01 cutoff', () => {
    const files = eopSourceFiles('2026-01-01');
    expect(files.map((f) => f.label)).toEqual([
      'Договори',
      'Поръчки',
      'Анекси',
      'Обявления (OCDS)',
    ]);
    expect(decodeURIComponent(files[3]!.url)).toContain('съгласно стандарт OCDS.json');
  });

  it('omits the OCDS export the day before the cutoff', () => {
    expect(eopSourceFiles('2025-12-31')).toHaveLength(3);
  });
});
