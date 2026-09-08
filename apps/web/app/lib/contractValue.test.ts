import { describe, it, expect } from 'vitest';
import type { ContractValueTimeline } from '@sigma/api-contract';
import { money, pct } from '@sigma/shared';
import { unverifiedValueNote } from './contractValue';

const base: ContractValueTimeline = {
  estimatedEur: 4092,
  procedureEstimatedEur: 265124,
  signingEur: 92,
  currentEur: 92,
  deltaPct: null,
  suspect: false,
  flag: 'ok',
  currentValueDoubled: false,
};
const v = (over: Partial<ContractValueTimeline>): ContractValueTimeline => ({ ...base, ...over });

describe('unverifiedValueNote', () => {
  it('says nothing about a clean value', () => {
    expect(unverifiedValueNote(base)).toBeNull();
  });

  it('quotes both figures and the threshold for the low-value case', () => {
    // The contract that prompted this: three lots each published as 180,00 лв. against forecasts of
    // 493 870 / 16 666 / 8 004 лв. — a unit price in the contract-value field.
    const note = unverifiedValueNote(v({ suspect: true, flag: 'value_low' }))!;
    expect(note.scope).toBe('both');
    // Built from the shared formatter rather than typed out: it uses non-breaking spaces.
    expect(note.headline).toContain(money(92));
    expect(note.headline).toContain(money(4092));
    expect(note.headline).toContain(pct(0.05, 0));
    expect(note.detail).toContain('ЦАИС ЕОП');
  });

  it('does not claim a percentage when there is no usable forecast', () => {
    const note = unverifiedValueNote(v({ suspect: true, flag: 'value_low', estimatedEur: null }))!;
    expect(note.headline).toContain('несъразмерно ниска');
    expect(note.headline).not.toContain('%');
  });

  it('reports a non-positive published value as such, not as a percentage', () => {
    const note = unverifiedValueNote(
      v({ suspect: true, flag: 'value_low', signingEur: 0, currentEur: 0 }),
    )!;
    expect(note.headline).toContain(`Публикуваната стойност на договора е ${money(0)}`);
    expect(note.headline).not.toContain('%');
  });

  it('calls a huge current value a jump, not a low value', () => {
    // 73 contracts are value_low on their signing value while displaying ≥100 000 €; the extreme is
    // signed for 0,01 лв. with a current value of 37 млн. лв. „Too low" is the wrong sentence there.
    const note = unverifiedValueNote(
      v({ suspect: true, flag: 'value_low', signingEur: 0.01, currentEur: 18_900_000 }),
    )!;
    expect(note.badge).toBe('скок след изменения');
    expect(note.headline).toContain('разминават в пъти');
  });

  it('keeps the doubled-annex verdict on the current value only', () => {
    const note = unverifiedValueNote(
      v({
        suspect: true,
        flag: 'annex_total_suspect',
        currentEur: null,
        currentValueDoubled: true,
      }),
    )!;
    expect(note.scope).toBe('current');
    expect(note.badge).toBe('двойно отчетена');
  });

  it('falls back to a generic sentence for the other verdicts', () => {
    for (const flag of ['value_suspect', 'annex_suspect', 'review'] as const) {
      const note = unverifiedValueNote(v({ suspect: true, flag }))!;
      expect(note.badge).toBe('непотвърдена стойност');
      expect(note.scope).toBe('both');
      // The catch-all cases are our verdict, not a demonstrable source defect — the heading must not
      // claim the source got it wrong when the sentence under it only says our checks failed.
      expect(note.title).not.toContain('източника');
    }
  });
});
