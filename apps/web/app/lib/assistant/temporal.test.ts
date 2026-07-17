import { describe, expect, it } from 'vitest';
import { resolveTemporalContext } from './temporal';

// Every case injects `now` (never the wall clock), so the whole suite is deterministic and passes
// identically on any CI date — closing the exact clock-dependence that produced the bug.
//
// Reference instant: 2026-07-02T09:00:00Z → Europe/Sofia (EEST, UTC+3 in July) = 2026-07-02, a Thursday.
// So today=2026-07-02, tomorrow=2026-07-03, month=July, quarter=Q3, this-week Monday=2026-06-29.
const JUL_2 = new Date('2026-07-02T09:00:00Z');

describe('resolveTemporalContext — primary period bounds (injected clock)', () => {
  const cases: [string, string, Date, { since: string; until: string; label?: string }][] = [
    // --- relative year ---
    [
      'тази година',
      'поръчките за тази година',
      JUL_2,
      { since: '2026-01-01', until: '2026-07-03', label: '2026' },
    ],
    [
      'миналата година',
      'договори миналата година',
      JUL_2,
      { since: '2025-01-01', until: '2026-01-01', label: '2025' },
    ],
    [
      'предходната година',
      'разход предходната година',
      JUL_2,
      { since: '2025-01-01', until: '2026-01-01' },
    ],
    // --- relative month (+ current-period clamp to tomorrow) ---
    [
      'този месец',
      'поръчки този месец',
      JUL_2,
      { since: '2026-07-01', until: '2026-07-03', label: 'юли 2026' },
    ],
    [
      'миналия месец',
      'договори миналия месец',
      JUL_2,
      { since: '2026-06-01', until: '2026-07-01', label: 'юни 2026' },
    ],
    // year-rollover: previous month asked in January → December of the prior year
    [
      'миналия месец (януари → декември м.г.)',
      'миналия месец',
      new Date('2026-01-15T09:00:00Z'),
      { since: '2025-12-01', until: '2026-01-01', label: 'декември 2025' },
    ],
    // --- quarter: последното/това = current quarter to date; миналото = previous ---
    [
      'това тримесечие',
      'разход това тримесечие',
      JUL_2,
      { since: '2026-07-01', until: '2026-07-03', label: 'Q3 2026' },
    ],
    [
      'последното тримесечие (= текущото)',
      'последното тримесечие',
      JUL_2,
      { since: '2026-07-01', until: '2026-07-03', label: 'Q3 2026' },
    ],
    [
      'миналото тримесечие',
      'миналото тримесечие',
      JUL_2,
      { since: '2026-04-01', until: '2026-07-01', label: 'Q2 2026' },
    ],
    // year-rollover: previous quarter asked in Q1 → Q4 of the prior year
    [
      'миналото тримесечие (Q1 → Q4 м.г.)',
      'миналото тримесечие',
      new Date('2026-02-10T09:00:00Z'),
      { since: '2025-10-01', until: '2026-01-01', label: 'Q4 2025' },
    ],
    // --- ISO week (Mon–Sun) ---
    ['тази седмица', 'поръчки тази седмица', JUL_2, { since: '2026-06-29', until: '2026-07-03' }],
    [
      'миналата седмица',
      'договори миналата седмица',
      JUL_2,
      { since: '2026-06-22', until: '2026-06-29' },
    ],
    // year-rollover: current week in early January starts in December of the prior year (ISO week)
    [
      'тази седмица (крос-година)',
      'тази седмица',
      new Date('2026-01-01T09:00:00Z'),
      { since: '2025-12-29', until: '2026-01-02' },
    ],
    // --- rolling last-N-days ---
    ['последните 30 дни', 'последните 30 дни', JUL_2, { since: '2026-06-03', until: '2026-07-03' }],
    ['последните 7 дни', 'последните 7 дни', JUL_2, { since: '2026-06-26', until: '2026-07-03' }],
    // --- trailing calendar months (digits + word numeral) ---
    [
      'последните 6 месеца',
      'последните 6 месеца',
      JUL_2,
      { since: '2026-02-01', until: '2026-07-03' },
    ],
    [
      'последните три месеца (словом)',
      'последните три месеца',
      JUL_2,
      { since: '2026-05-01', until: '2026-07-03' },
    ],
    // --- single day ---
    ['днес', 'колко договора днес', JUL_2, { since: '2026-07-02', until: '2026-07-03' }],
    ['вчера', 'договори вчера', JUL_2, { since: '2026-07-01', until: '2026-07-02' }],
    // --- explicit year / range (must ignore `now`) ---
    [
      'през 2023',
      'поръчки през 2023',
      JUL_2,
      { since: '2023-01-01', until: '2024-01-01', label: '2023' },
    ],
    ['bare year 2019', 'разходите 2019', JUL_2, { since: '2019-01-01', until: '2020-01-01' }],
    // explicit FUTURE year keeps its real span — must NOT invert to an always-empty range
    // (`>= 2027-01-01 AND < tomorrow`); the to-date clamp only applies to already-started periods.
    [
      'future year 2027 (no clamp/inversion)',
      'поръчки през 2027',
      JUL_2,
      { since: '2027-01-01', until: '2028-01-01', label: '2027' },
    ],
    [
      'между 2021 и 2023 (inclusive upper)',
      'между 2021 и 2023',
      JUL_2,
      { since: '2021-01-01', until: '2024-01-01', label: '2021–2023' },
    ],
    // --- explicit ISO calendar tokens (absolute; parsed before the relative/year branches) ---
    [
      'ISO range „от D до D"',
      'договори от 2025-01-01 до 2025-03-31',
      JUL_2,
      { since: '2025-01-01', until: '2025-04-01', label: '2025-01-01 – 2025-03-31' },
    ],
    // en/em-dash form (the starter-prompt „2026-06-26–2026-07-03" layout), endpoints written high→low:
    // the resolver normalises to lo–hi so the bounds are order-independent.
    [
      'ISO range en-dash, reversed endpoints',
      'подписани 2025-03-31–2025-01-01',
      JUL_2,
      { since: '2025-01-01', until: '2025-04-01', label: '2025-01-01 – 2025-03-31' },
    ],
    [
      'single ISO day',
      'договори на 2025-06-15',
      JUL_2,
      { since: '2025-06-15', until: '2025-06-16', label: '2025-06-15' },
    ],
    [
      'ISO month YYYY-MM',
      'разход през 2026-05',
      JUL_2,
      { since: '2026-05-01', until: '2026-06-01', label: '2026-05' },
    ],
    // „2025-та" is the spoken ordinal year, NOT an ISO date — must resolve to the whole year, not a day.
    [
      'ordinal year „2025-та"',
      'топ възложители 2025-та година',
      JUL_2,
      { since: '2025-01-01', until: '2026-01-01', label: '2025' },
    ],
    // --- Sofia timezone: a late-UTC instant on Jun 30 is already July 1 in Sofia ---
    [
      'този месец (near-midnight Sofia)',
      'този месец',
      new Date('2026-06-30T22:30:00Z'),
      { since: '2026-07-01', until: '2026-07-02' },
    ],
  ];

  it.each(cases)('%s', (_name, question, now, expected) => {
    const ctx = resolveTemporalContext(question, now);
    expect(ctx).not.toBeNull();
    expect(ctx!.primary.sinceIso).toBe(expected.since);
    expect(ctx!.primary.untilIso).toBe(expected.until);
    if (expected.label) expect(ctx!.primary.label).toBe(expected.label);
  });
});

describe('resolveTemporalContext — negative (no spurious filter)', () => {
  const nulls: [string, string][] = [
    ['pure aggregate by year', 'разход по година'],
    ['top authorities, no period', 'най-големите възложители по похарчено'],
    ['single-offer share, no period', 'дял на договорите с една оферта'],
    ['empty question', ''],
    // breakdown „по тримесечия" is NOT a period — a bare, modifier-less тримесечи must not inject a
    // this-quarter filter (else the report silently shows only Q3-to-date). (review: ydimitrof)
    ['quarter breakdown, no modifier', 'разход по тримесечия'],
    ['quarters over time, no modifier', 'договори по тримесечия за периода'],
    // a 4-digit run inside a procurement id must not be read as an explicit year → no filter.
    ['year token inside procurement id', 'кой спечели поръчка 00087-2020-0027'],
    ['year token inside a longer number', 'договор на стойност 12026 лева'],
    // a malformed ISO date (month 13 / day 40) is not a valid day, month, or bare year → no spurious filter.
    ['malformed ISO date', 'договори на 2025-13-40'],
  ];
  it.each(nulls)('%s → null', (_name, question) => {
    expect(resolveTemporalContext(question, JUL_2)).toBeNull();
  });
});

describe('resolveTemporalContext — freshness (recency caveat)', () => {
  it('flags the current calendar year as recent (ingest lag may make it partial)', () => {
    const ctx = resolveTemporalContext('тази година', JUL_2);
    expect(ctx!.primary.recencyCaveat).toBe(true);
  });

  it('does NOT flag a fully-settled prior year', () => {
    const ctx = resolveTemporalContext('миналата година', JUL_2); // 2025, ended 2026-01-01
    expect(ctx!.primary.recencyCaveat).toBe(false);
  });

  it('flags the previous month (empty may mean data not yet landed, not zero activity)', () => {
    const ctx = resolveTemporalContext('миналия месец', JUL_2); // June, ended 2026-07-01
    expect(ctx!.primary.recencyCaveat).toBe(true);
  });

  // The explicit-year branch (detectPrimary step 9) — the user's canonical „за 2025" / „за 2026" forms.
  // recencyCaveat is a DISCLOSURE signal only (ingest may still be landing); the dedup gate keys on
  // `stableBounds` instead (see the dedup-stability block below and ADR-0010). Distinct code path from the
  // relative „тази/миналата година" cases above.
  it('does NOT flag an explicit settled year („за 2025")', () => {
    const ctx = resolveTemporalContext('топ 3 възложители за 2025', JUL_2);
    expect(ctx!.primary.key).toBe('explicit-year');
    expect(ctx!.primary.recencyCaveat).toBe(false);
  });

  it('flags an explicit CURRENT/partial year („за 2026")', () => {
    const ctx = resolveTemporalContext('топ 3 възложители за 2026', JUL_2);
    expect(ctx!.primary.key).toBe('explicit-year');
    expect(ctx!.primary.recencyCaveat).toBe(true);
  });
});

describe('resolveTemporalContext — dedup stability (stableBounds, ADR-0010)', () => {
  // stableBounds encodes ONE question: will this phrase resolve to these EXACT bounds no matter WHEN it is
  // asked? Absolute calendar tokens (year / ISO date / ISO month / range) that are NOT clamped to the
  // moving „tomorrow" are clock-independent → dedup-eligible. Late same-day ingest is handled elsewhere
  // (the data-version token in the dedup key), so it is not this flag's concern. Every relative phrase —
  // and any absolute period whose tail is clamped to today — is clock-dependent → must not dedup.
  const stable = (q: string, now: Date): boolean =>
    resolveTemporalContext(q, now)!.primary.stableBounds;

  it('settled explicit year → stable', () => {
    expect(stable('топ 3 възложители за 2025', JUL_2)).toBe(true);
  });

  it('current explicit year → clamped to today → NOT stable', () => {
    expect(stable('топ 3 възложители за 2026', JUL_2)).toBe(false);
  });

  it('fully-past ISO range → stable', () => {
    // asked well after the range closed (clock 2026-08-15) — bounds can no longer move.
    expect(stable('договори от 2026-06-01 до 2026-06-30', new Date('2026-08-15T09:00:00Z'))).toBe(
      true,
    );
  });

  it('ISO range whose tail reaches today → clamped → NOT stable (the safety buffer)', () => {
    // 2026-06-01–2026-07-03 asked on 2026-07-02: the upper bound is tomorrow, so the tail is still
    // unsettled and the resolved end moves with the clock — it must not pin an answer yet. The range only
    // becomes dedup-stable once the clock passes its end. (the user's „2026-06-01 - 2026-07-03" scenario)
    expect(stable('подписани 2026-06-01–2026-07-03', JUL_2)).toBe(false);
  });

  it('past single ISO day → stable', () => {
    expect(stable('договори на 2025-06-15', JUL_2)).toBe(true);
  });

  it('settled ISO month → stable', () => {
    expect(stable('разход през 2026-05', JUL_2)).toBe(true);
  });

  it('current ISO month → clamped → NOT stable', () => {
    expect(stable('разход през 2026-07', JUL_2)).toBe(false);
  });

  it('year range „между 2021 и 2023" → stable', () => {
    expect(stable('между 2021 и 2023', JUL_2)).toBe(true);
  });

  it.each([
    ['този месец', 'поръчки този месец'],
    ['днес', 'договори днес'],
    ['последните 30 дни', 'договори последните 30 дни'],
    ['тази година', 'разход тази година'],
  ])('relative „%s" → NOT stable (clock-relative)', (_name, q) => {
    expect(stable(q, JUL_2)).toBe(false);
  });
});

describe('resolveTemporalContext — common table + anchor', () => {
  it('always resolves the common comparison periods and the authoritative today', () => {
    const ctx = resolveTemporalContext('тази година спрямо миналата', JUL_2)!;
    expect(ctx.todayIso).toBe('2026-07-02');
    expect(ctx.anchorLabel).toContain('година 2026');
    const keys = ctx.common.map((p) => p.key);
    expect(keys).toContain('this-year');
    expect(keys).toContain('last-year');
    // the comparison counterpart is present in the pre-resolved table even though only one phrase is primary
    expect(ctx.common.find((p) => p.key === 'last-year')!.sinceIso).toBe('2025-01-01');
  });
});
