import { describe, expect, it } from 'vitest';
import { applyDefaultFilters } from './default-filters';

describe('applyDefaultFilters', () => {
  it('applies all three defaults with no options', () => {
    const r = applyDefaultFilters();
    expect(r.descriptor).toEqual({
      excludeNullAmount: true,
      excludeSynthetic: true,
      dateField: 'signed_at',
    });
    expect(r.dateColumn).toBe('c.signed_at');
    expect(r.sql.fragment).toBe('c.amount_eur IS NOT NULL AND t.procedure_type != ?');
    expect(r.sql.params).toEqual(['неизвестна']);
  });

  it('defaults to the rollup row-set (amount_eur IS NOT NULL), never value_flag', () => {
    // Aligns E3 with E4: the rollups range over amount_eur IS NOT NULL, which already INCLUDES
    // corrected value_suspect rows. Filtering on value_flag would drop rows the rollup counts and
    // make assertReconciled false-throw — so the default must not mention value_flag at all.
    const r = applyDefaultFilters();
    expect(r.sql.fragment).toContain('c.amount_eur IS NOT NULL');
    expect(r.sql.fragment).not.toContain('value_flag');
    expect(r.sql.params).not.toContain('value_suspect');
  });

  it('emits exactly the three default callout lines with no options', () => {
    expect(applyDefaultFilters().callout).toEqual([
      'По подразбиране са изключени договори без съпоставима канонична стойност (amount_eur липсва); те не се сумират и не са включени в обобщените тотали (rollups).',
      'По подразбиране са изключени синтетични поръчки с неизвестна процедура.',
      'Времевият анализ е по дата на подписване (signed_at).',
    ]);
  });

  it('opting into unsummable rows drops the amount filter and warns', () => {
    const r = applyDefaultFilters({ includeUnsummable: true });
    expect(r.descriptor.excludeNullAmount).toBe(false);
    expect(r.sql.fragment).not.toContain('amount_eur');
    expect(r.sql.params).toEqual(['неизвестна']);
    expect(r.callout).toContain(
      'ВНИМАНИЕ: по изрично искане са включени договори без канонична стойност (amount_eur липсва); тези редове няма да се съгласуват с обобщените тотали (rollups).',
    );
  });

  it('opting into synthetic drops the filter and warns', () => {
    const r = applyDefaultFilters({ includeSynthetic: true });
    expect(r.descriptor.excludeSynthetic).toBe(false);
    expect(r.sql.fragment).not.toContain('procedure_type');
    expect(r.sql.fragment).toBe('c.amount_eur IS NOT NULL');
    expect(r.sql.params).toEqual([]);
    expect(r.callout).toContain(
      'ВНИМАНИЕ: по изрично искане са включени синтетични поръчки (неизвестна процедура).',
    );
  });

  it('switching the date field to published_at warns and exposes the column', () => {
    const r = applyDefaultFilters({ dateField: 'published_at' });
    expect(r.descriptor.dateField).toBe('published_at');
    expect(r.dateColumn).toBe('c.published_at');
    expect(r.callout).toContain(
      'ВНИМАНИЕ: по изрично искане времевият анализ е по дата на публикуване (published_at) вместо signed_at.',
    );
  });

  it('accumulates callouts and empties the SQL fragment when all defaults are opted out', () => {
    const r = applyDefaultFilters({
      includeUnsummable: true,
      includeSynthetic: true,
      dateField: 'published_at',
    });
    expect(r.sql.fragment).toBe('');
    expect(r.sql.params).toEqual([]);
    expect(r.callout).toHaveLength(3);
    expect(r.callout.every((line) => line.startsWith('ВНИМАНИЕ'))).toBe(true);
  });

  it('parameterizes literals rather than inlining them (no string interpolation)', () => {
    const r = applyDefaultFilters();
    expect(r.sql.fragment).not.toContain("'неизвестна'");
    expect((r.sql.fragment.match(/\?/g) ?? []).length).toBe(r.sql.params.length);
  });

  it('is deterministic', () => {
    const a = applyDefaultFilters({ includeSynthetic: true });
    const b = applyDefaultFilters({ includeSynthetic: true });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
