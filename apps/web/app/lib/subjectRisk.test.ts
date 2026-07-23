import { describe, it, expect } from 'vitest';
import type { SubjectRiskAggregate } from '@sigma/api-contract';
import { buildSubjectRisk } from './subjectRisk';

function agg(o: Partial<SubjectRiskAggregate> = {}): SubjectRiskAggregate {
  return {
    singleOfferK: null,
    singleOfferN: null,
    singleOfferValueShare: null,
    highMarkupK: null,
    highMarkupN: null,
    highMarkupValueShare: null,
    ...o,
  };
}

describe('buildSubjectRisk', () => {
  it('suppresses everything for a natural-person profile (M9)', () => {
    expect(
      buildSubjectRisk(agg({ singleOfferK: 5, singleOfferN: 5 }), { isNaturalPerson: true }),
    ).toBeNull();
  });

  it('returns null when there is no aggregate row', () => {
    expect(buildSubjectRisk(null, { isNaturalPerson: false })).toBeNull();
  });

  it('suppresses when no component has enough assessable contracts (min-N, M3)', () => {
    expect(
      buildSubjectRisk(agg({ singleOfferK: 4, singleOfferN: 4, highMarkupK: 2, highMarkupN: 2 }), {
        isNaturalPerson: false,
      }),
    ).toBeNull();
  });

  it('reports a component exactly at the min-N boundary (n = 5)', () => {
    expect(
      buildSubjectRisk(agg({ singleOfferK: 1, singleOfferN: 5 }), { isNaturalPerson: false }),
    ).toEqual({
      composite: 0.2,
      band: 'some',
      components: [{ key: 'single_offer', k: 1, n: 5, countShare: 0.2, valueShare: null }],
    });
  });

  it('bands a zero composite as „few"', () => {
    expect(
      buildSubjectRisk(agg({ singleOfferK: 0, singleOfferN: 5 }), { isNaturalPerson: false })?.band,
    ).toBe('few');
  });

  it('bands a full composite as „most"', () => {
    expect(
      buildSubjectRisk(agg({ singleOfferK: 5, singleOfferN: 5 }), { isNaturalPerson: false })?.band,
    ).toBe('most');
  });

  it('averages reportable components for the composite (count-weighted)', () => {
    // single-offer 5/5 = 1.0, high-markup 0/5 = 0.0 → composite 0.5 → „many" (< 0.55).
    const view = buildSubjectRisk(
      agg({ singleOfferK: 5, singleOfferN: 5, highMarkupK: 0, highMarkupN: 5 }),
      { isNaturalPerson: false },
    );
    expect(view?.composite).toBe(0.5);
    expect(view?.band).toBe('many');
    expect(view?.components).toHaveLength(2);
  });

  it('drops a thin component from the composite but keeps the reportable one', () => {
    // single-offer n=5 reportable; high-markup n=3 dropped → composite is single-offer only.
    const view = buildSubjectRisk(
      agg({ singleOfferK: 3, singleOfferN: 5, highMarkupK: 3, highMarkupN: 3 }),
      { isNaturalPerson: false },
    );
    expect(view?.components).toEqual([
      { key: 'single_offer', k: 3, n: 5, countShare: 0.6, valueShare: null },
    ]);
    expect(view?.composite).toBe(0.6);
  });

  it('passes the value share through unchanged', () => {
    const view = buildSubjectRisk(
      agg({ singleOfferK: 3, singleOfferN: 5, singleOfferValueShare: 0.42 }),
      { isNaturalPerson: false },
    );
    expect(view?.components[0]?.valueShare).toBe(0.42);
  });
});
