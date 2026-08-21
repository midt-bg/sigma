import { describe, expect, it } from 'vitest';
import { moneyBare } from '@sigma/shared';
import type { ConflictContract, ConflictContractFacts, ConflictLink } from '@sigma/api-contract';
import {
  authorityShareDisplay,
  authorityShares,
  companyConflictsHref,
  companyProfileHref,
  contractHref,
  contractTemporal,
  contractTimeline,
  contractYear,
  contractYearsLabel,
  contractsCountLabel,
  fundsCellLabel,
  fundsMagnitude,
  hasContemporaneousContracts,
  conflictHeadline,
  groupByPerson,
  isHttpsUrl,
  markContracts,
  officialHref,
  partitionContracts,
  personFundsCell,
  relationLabel,
  temporalLabel,
  registryEvidenceLabel,
} from './conflicts';

function link(over: Partial<ConflictLink> = {}): ConflictLink {
  return {
    linkKey: 'person:a|111',
    officialSlug: 'c2VydA',
    official: 'Иван Минев',
    institution: 'Община Русе',
    company: 'ТРЕЙС ГРУП ХОЛД АД',
    eik: '111',
    relation: 'owns',
    contemporaneous: true,
    ownInstitution: false,
    firstDeclaredYear: '2019',
    lastDeclaredYear: '2023',
    matchMethod: 'exact_name_key',
    contractCount: 35,
    contractValueEur: 88_000_000,
    contemporaneousContractCount: 20,
    contemporaneousValueEur: 40_000_000,
    firstContractYear: '2021',
    lastContractYear: '2024',
    sourceUrl: 'https://register.cacbg.bg/2024/x.xml',
    // #279: a link only reaches the DTO when its identity rests on a Trade Register fact.
    evidenceKind: 'document',
    registryRole: 'owner',
    registryEntryNumber: '20110502101007',
    registryEntryDate: '2011-05-02',
    registryLookupDate: '2026-08-05',
    ...over,
  };
}

function contract(over: Partial<ConflictContract> = {}): ConflictContract {
  return {
    contractSlug: 'e:abc123',
    signedAt: '2021-05-01',
    authority: 'Община Пловдив',
    authorityId: 'a:plovdiv',
    authorityTotalEur: 10_000_000,
    contractKind: 'Услуги',
    procedureType: 'открита процедура',
    subject: 'Ремонт на общински път',
    contractNumber: 'Д-1',
    amountEur: 1_000_000,
    temporal: 'contemporaneous',
    ...over,
  };
}

describe('relationLabel', () => {
  it('renders each declared relation in Bulgarian', () => {
    // Tense-neutral (never present-tense „owns/manages") — a declared stake must not read as current.
    expect(relationLabel('owns')).toBe('дялово участие');
    expect(relationLabel('manages')).toBe('управление');
    expect(relationLabel('owns+manages')).toBe('дялово участие и управление');
    // A relative's stake (ADR-0032) is marked as свързано лице — the relative is never named, and „деклариран"
    // keeps it tense-neutral like the rest.
    expect(relationLabel('related')).toBe('деклариран дял на свързано лице');
  });
  it('passes an unknown relation through rather than inventing a claim', () => {
    expect(relationLabel('mystery')).toBe('mystery');
  });
});

describe('href builders', () => {
  it('point at the conflict + company routes', () => {
    expect(officialHref('c2VydA')).toBe('/conflicts/official/c2VydA');
    expect(companyConflictsHref('111')).toBe('/conflicts/company/111');
    expect(companyProfileHref('111')).toBe('/companies/111');
  });
});

describe('contractYearsLabel', () => {
  it('renders a range, a single year, or an em dash', () => {
    expect(contractYearsLabel('2021', '2024')).toBe('2021 – 2024');
    expect(contractYearsLabel('2023', '2023')).toBe('2023');
    expect(contractYearsLabel('2023', null)).toBe('2023');
    expect(contractYearsLabel(null, '2024')).toBe('2024');
    expect(contractYearsLabel(null, null)).toBe('—');
  });
});

describe('conflictHeadline', () => {
  // Money is aggregated per ЕИК, not per link (a winner's € belongs to the company, not to each linked
  // official); linkCount/officialCount stay per-link/per-official. Distinct ЕИК here → the sum is unaffected.
  it('sums value, counts links, and de-dupes officials', () => {
    const h = conflictHeadline([
      link({ officialSlug: 'a', eik: '1', contractValueEur: 100, contemporaneousValueEur: 60 }),
      link({ officialSlug: 'a', eik: '2', contractValueEur: 50, contemporaneousValueEur: 30 }),
      link({ officialSlug: 'b', eik: '3', contractValueEur: 25, contemporaneousValueEur: 10 }),
    ]);
    expect(h.linkCount).toBe(3);
    expect(h.officialCount).toBe(2); // de-duped
    expect(h.totalEur).toBe(175);
    expect(h.contemporaneousEur).toBe(100); // 60 + 30 + 10 — the conflict-window subset
  });
  // NOT_REDUNDANT_FAMILY (related-persons.ts) collapses only a SAME official's own+relative stake in one
  // winner, so two DIFFERENT officials on the SAME winner both reach this array — a plain per-link sum would
  // count that winner's € twice (#226, Todor: +8,1% / ~7,9M € on the full corpus). Money is deduped per ЕИК:
  // contract_value_eur is constant within a ЕИК (exact); contemporaneous_value_eur is a per-link window subset,
  // so the MAX per ЕИК is taken (deterministic, never overstated). Counts stay per-link/per-official.
  it('counts a winner’s money once across two different officials on the same ЕИК', () => {
    const h = conflictHeadline([
      link({
        officialSlug: 'a',
        eik: '111',
        contractValueEur: 88_000_000,
        contemporaneousValueEur: 40_000_000,
      }),
      link({
        officialSlug: 'b',
        eik: '111',
        contractValueEur: 88_000_000,
        contemporaneousValueEur: 25_000_000,
      }),
      link({
        officialSlug: 'c',
        eik: '222',
        contractValueEur: 10_000_000,
        contemporaneousValueEur: 5_000_000,
      }),
    ]);
    expect(h.linkCount).toBe(3); // still three links
    expect(h.officialCount).toBe(3); // three distinct officials
    expect(h.totalEur).toBe(98_000_000); // 88M once + 10M — NOT 88 + 88 + 10
    expect(h.contemporaneousEur).toBe(45_000_000); // max(40M, 25M) for ЕИК 111 + 5M — never doubled
  });
  it('treats a null contract value as zero, never NaN', () => {
    const h = conflictHeadline([link({ contractValueEur: null, contemporaneousValueEur: null })]);
    expect(h.totalEur).toBe(0);
    expect(h.contemporaneousEur).toBe(0);
    expect(Number.isNaN(h.contemporaneousEur)).toBe(false);
  });
  it('is empty-safe', () => {
    expect(conflictHeadline([])).toEqual({
      linkCount: 0,
      officialCount: 0,
      totalEur: 0,
      contemporaneousEur: 0,
    });
  });
});

describe('contemporaneous split', () => {
  it('hasContemporaneousContracts is true only when a contract fell in the window', () => {
    expect(hasContemporaneousContracts(link({ contemporaneousContractCount: 3 }))).toBe(true);
    expect(hasContemporaneousContracts(link({ contemporaneousContractCount: 0 }))).toBe(false);
  });
  it('contractsCountLabel shows „X от Y" only when some are in the window', () => {
    expect(contractsCountLabel(link({ contemporaneousContractCount: 3, contractCount: 11 }))).toBe(
      '3 от 11',
    );
    // no in-window contract → just the total, never „0 от 11" (reads as a claim of zero conflict)
    expect(contractsCountLabel(link({ contemporaneousContractCount: 0, contractCount: 11 }))).toBe(
      '11',
    );
  });
  it('fundsCellLabel leads with the conflict figure and keeps the total as context', () => {
    const withWindow = fundsCellLabel(
      link({
        contemporaneousContractCount: 2,
        contemporaneousValueEur: 2_000_000,
        contractValueEur: 5_000_000,
      }),
    );
    expect(withWindow.primary).toBe(moneyBare(2_000_000)); // conflict-window sum first
    expect(withWindow.total).toBe(moneyBare(5_000_000)); // total kept as context
    // no in-window contract → only the total, nothing to split
    const noWindow = fundsCellLabel(
      link({ contemporaneousContractCount: 0, contractValueEur: 5_000_000 }),
    );
    expect(noWindow.primary).toBe(moneyBare(5_000_000));
    expect(noWindow.total).toBeNull();
    // in-window count but no summable value → fall back to the total, no phantom split
    const noValue = fundsCellLabel(
      link({
        contemporaneousContractCount: 2,
        contemporaneousValueEur: null,
        contractValueEur: 5_000_000,
      }),
    );
    expect(noValue.total).toBeNull();
  });

  it('personFundsCell mirrors the split over a collapsed person row — no synthetic link, no cast', () => {
    // an in-window sum → the window figure leads, the total is kept as „от" context
    const withWindow = personFundsCell({
      hasContemporaneous: true,
      contemporaneousValueEur: 3_000_000,
      contractValueEur: 8_000_000,
    });
    expect(withWindow.primary).toBe(moneyBare(3_000_000));
    expect(withWindow.total).toBe(moneyBare(8_000_000));
    // nothing signed in the window → only the total, no split
    const noWindow = personFundsCell({
      hasContemporaneous: false,
      contemporaneousValueEur: 0,
      contractValueEur: 8_000_000,
    });
    expect(noWindow.primary).toBe(moneyBare(8_000_000));
    expect(noWindow.total).toBeNull();
  });
});

describe('fundsMagnitude', () => {
  it('is the conflict-window share of the total (subset ≤ total)', () => {
    expect(
      fundsMagnitude(
        link({
          contemporaneousContractCount: 2,
          contemporaneousValueEur: 132_000,
          contractValueEur: 11_900_000,
        }),
      ),
    ).toBeCloseTo(132_000 / 11_900_000, 6);
  });
  it('is null when there is nothing to plot', () => {
    // no in-window contract
    expect(fundsMagnitude(link({ contemporaneousContractCount: 0 }))).toBeNull();
    // no summable window value
    expect(
      fundsMagnitude(link({ contemporaneousContractCount: 2, contemporaneousValueEur: null })),
    ).toBeNull();
    // no/zero total to divide by
    expect(
      fundsMagnitude(
        link({
          contemporaneousContractCount: 2,
          contemporaneousValueEur: 100,
          contractValueEur: 0,
        }),
      ),
    ).toBeNull();
    expect(
      fundsMagnitude(
        link({
          contemporaneousContractCount: 2,
          contemporaneousValueEur: 100,
          contractValueEur: null,
        }),
      ),
    ).toBeNull();
  });
  it('clamps to 1 rather than exceeding the bar', () => {
    expect(
      fundsMagnitude(
        link({
          contemporaneousContractCount: 2,
          contemporaneousValueEur: 120,
          contractValueEur: 100,
        }),
      ),
    ).toBe(1);
  });
});

describe('contractTimeline', () => {
  it('places dated contracts on a shared axis and shades the declared window', () => {
    const tl = contractTimeline({ firstDeclaredYear: '2024', lastDeclaredYear: '2024' }, [
      contract({ signedAt: '2019-03-01', temporal: 'before' }),
      contract({ signedAt: '2024-06-01', temporal: 'contemporaneous' }),
      contract({ signedAt: '2024-09-01', temporal: 'contemporaneous' }),
      contract({ signedAt: '2026-01-01', temporal: 'after' }),
    ]);
    expect(tl).not.toBeNull();
    expect(tl!.minYear).toBe(2019);
    expect(tl!.maxYear).toBe(2026);
    // 2019 at 0%, 2026 at 100%, 2024 at (5/7)*100
    expect(tl!.marks[0]).toMatchObject({ year: 2019, leftPct: 0, inWindow: false, stackIndex: 0 });
    expect(tl!.marks[3]).toMatchObject({ year: 2026, leftPct: 100, inWindow: false });
    expect(tl!.windowStartPct).toBeCloseTo((5 / 7) * 100, 6);
    expect(tl!.windowEndPct).toBeCloseTo((5 / 7) * 100, 6);
    // the two 2024 contracts are flagged in-window and fanned by stackIndex
    const inWin = tl!.marks.filter((m) => m.inWindow);
    expect(inWin.map((m) => m.stackIndex)).toEqual([0, 1]);
    // year ticks: a short span labels every year, start at 0% and end at 100% (middle years present)
    expect(tl!.ticks.map((t) => t.year)).toEqual([2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
    expect(tl!.ticks[0].leftPct).toBe(0);
    expect(tl!.ticks[tl!.ticks.length - 1].leftPct).toBe(100);
  });
  it('thins year ticks on a long span but always keeps the end year', () => {
    // 2000 → 2020 span 20 → step ceil(21/8)=3 → 2000,2003,…,2018, then the end year 2020 appended exactly
    const tl = contractTimeline({ firstDeclaredYear: '2000', lastDeclaredYear: '2000' }, [
      contract({ signedAt: '2000-01-01', temporal: 'contemporaneous' }),
      contract({ signedAt: '2020-01-01', temporal: 'after' }),
    ]);
    const years = tl!.ticks.map((t) => t.year);
    expect(years).toEqual([2000, 2003, 2006, 2009, 2012, 2015, 2018, 2020]);
    expect(tl!.ticks[tl!.ticks.length - 1].leftPct).toBe(100);
  });
  it('renders a single centred tick when all activity is in one year', () => {
    const tl = contractTimeline({ firstDeclaredYear: '2024', lastDeclaredYear: '2024' }, [
      contract({ signedAt: '2024-01-01', temporal: 'contemporaneous' }),
    ]);
    expect(tl!.ticks).toEqual([{ year: 2024, leftPct: 50 }]);
  });
  it('returns null when no contract carries a date (nothing to plot)', () => {
    expect(
      contractTimeline({ firstDeclaredYear: '2024', lastDeclaredYear: '2024' }, [
        contract({ signedAt: null, temporal: 'unknown' }),
      ]),
    ).toBeNull();
  });
  it('centres everything when all activity is in one year (zero span, no divide-by-zero)', () => {
    const tl = contractTimeline({ firstDeclaredYear: '2024', lastDeclaredYear: '2024' }, [
      contract({ signedAt: '2024-01-01', temporal: 'contemporaneous' }),
    ]);
    expect(tl!.marks[0].leftPct).toBe(50);
    expect(tl!.windowStartPct).toBe(50);
    expect(tl!.windowEndPct).toBe(50);
  });
  it('plots marks with no band when the link declares no years', () => {
    const tl = contractTimeline({ firstDeclaredYear: null, lastDeclaredYear: null }, [
      contract({ signedAt: '2021-01-01', temporal: 'before' }),
      contract({ signedAt: '2023-01-01', temporal: 'after' }),
    ]);
    expect(tl!.windowStartPct).toBeNull();
    expect(tl!.windowEndPct).toBeNull();
    expect(tl!.marks).toHaveLength(2);
  });
  it('ignores a bogus/empty declared year rather than plotting year 0', () => {
    const tl = contractTimeline({ firstDeclaredYear: '', lastDeclaredYear: '2024' }, [
      contract({ signedAt: '2024-01-01', temporal: 'contemporaneous' }),
    ]);
    // only the valid edge remains; band collapses to that single point, min/max stay 2024
    expect(tl!.minYear).toBe(2024);
    expect(tl!.windowStartPct).toBe(50);
    expect(tl!.windowEndPct).toBe(50);
  });
});

describe('contract list helpers', () => {
  it('partitionContracts splits the window set from the rest', () => {
    const contracts = [
      contract({ temporal: 'contemporaneous', contractNumber: 'A' }),
      contract({ temporal: 'before', contractNumber: 'B' }),
      contract({ temporal: 'after', contractNumber: 'C' }),
      contract({ temporal: 'unknown', contractNumber: 'D' }),
    ];
    const { inConflict, outside } = partitionContracts(contracts);
    expect(inConflict.map((c) => c.contractNumber)).toEqual(['A']);
    expect(outside.map((c) => c.contractNumber)).toEqual(['B', 'C', 'D']);
  });
  it('temporalLabel frames each contract vs the DECLARED (disclosure) period, not ownership', () => {
    // „деклариран период", never „дял" — the label must not imply an ownership boundary we can't prove
    // (real ownership usually predates the first filing; the declared years are only the disclosure window).
    expect(temporalLabel('contemporaneous')).toBe('в декларирания период');
    expect(temporalLabel('before')).toBe('преди декларирания период');
    expect(temporalLabel('after')).toBe('след декларирания период');
    expect(temporalLabel('unknown')).toBe('без дата');
  });
  it('contractYear takes the signing year, or „—" when undated', () => {
    expect(contractYear(contract({ signedAt: '2021-05-01' }))).toBe('2021');
    expect(contractYear(contract({ signedAt: null }))).toBe('—');
  });
  it('contractHref points at the contract detail page', () => {
    expect(contractHref(contract({ contractSlug: 'e:abc123' }))).toBe('/contracts/e:abc123');
  });
});

describe('isHttpsUrl', () => {
  it('accepts only absolute https URLs', () => {
    expect(isHttpsUrl('https://register.cacbg.bg/2024/i.xml')).toBe(true);
  });
  it('rejects null, non-https schemes, and unparseable values (no href injection)', () => {
    expect(isHttpsUrl(null)).toBe(false);
    expect(isHttpsUrl(undefined)).toBe(false);
    expect(isHttpsUrl('')).toBe(false);
    expect(isHttpsUrl('http://register.cacbg.bg/x')).toBe(false); // plain http
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpsUrl('data:text/html,<script>1</script>')).toBe(false);
    expect(isHttpsUrl('/2024/i.xml')).toBe(false); // relative → unparseable as absolute
    expect(isHttpsUrl('register.cacbg.bg/x')).toBe(false);
  });
});

describe('authorityShares', () => {
  it('groups by authority, computes the capture share, and sorts strongest first', () => {
    // Body A: winner took 2M of a 10M body = 20%. Body B: 1M of a 2M body = 50% → B leads on share
    // despite A's larger absolute €.
    const shares = authorityShares([
      contract({
        authorityId: 'a:A',
        authority: 'Община А',
        amountEur: 2_000_000,
        authorityTotalEur: 10_000_000,
      }),
      contract({
        authorityId: 'a:B',
        authority: 'Община Б',
        amountEur: 1_000_000,
        authorityTotalEur: 2_000_000,
      }),
    ]);
    expect(shares.map((s) => s.authorityId)).toEqual(['a:B', 'a:A']);
    expect(shares[0]).toMatchObject({
      authority: 'Община Б',
      companyEur: 1_000_000,
      ratio: 0.5,
      contractCount: 1,
    });
    expect(shares[1]).toMatchObject({ authority: 'Община А', companyEur: 2_000_000, ratio: 0.2 });
  });

  it('sums the winner ALL its contracts at a body — window-consistent numerator over the all-time base', () => {
    // The denominator (authority_totals.spent_eur) is all-time; so the numerator must be all the winner's
    // contracts at that body, NOT just the in-window ones — else it is an in-window sum over an all-time base
    // (the exact framing trap). before + contemporaneous + after all count toward companyEur here.
    const shares = authorityShares([
      contract({
        authorityId: 'a:A',
        amountEur: 1_000_000,
        temporal: 'before',
        authorityTotalEur: 10_000_000,
      }),
      contract({
        authorityId: 'a:A',
        amountEur: 2_000_000,
        temporal: 'contemporaneous',
        authorityTotalEur: 10_000_000,
      }),
      contract({
        authorityId: 'a:A',
        amountEur: 1_000_000,
        temporal: 'after',
        authorityTotalEur: 10_000_000,
      }),
    ]);
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({
      companyEur: 4_000_000,
      ratio: 0.4,
      inWindow: true,
      contractCount: 3,
    });
  });

  it('marks inWindow only when a contract falls in the declared period', () => {
    const noWindow = authorityShares([
      contract({ authorityId: 'a:A', temporal: 'before' }),
      contract({ authorityId: 'a:A', temporal: 'after' }),
    ]);
    expect(noWindow[0].inWindow).toBe(false);
  });

  it('counts a null amount as 0, never NaN', () => {
    const shares = authorityShares([
      contract({ authorityId: 'a:A', amountEur: null, authorityTotalEur: 10_000_000 }),
      contract({ authorityId: 'a:A', amountEur: 500_000, authorityTotalEur: 10_000_000 }),
    ]);
    expect(shares[0].companyEur).toBe(500_000);
    expect(shares[0].ratio).toBe(0.05);
  });

  it('suppresses the ratio (null) when the body has no rollup denominator, and sorts it last', () => {
    const shares = authorityShares([
      contract({ authorityId: 'a:none', amountEur: 9_000_000, authorityTotalEur: null }),
      contract({ authorityId: 'a:A', amountEur: 1_000_000, authorityTotalEur: 10_000_000 }),
    ]);
    // The un-rolled-up body has a bigger € but no share → it must trail the body with a real share.
    expect(shares.map((s) => s.authorityId)).toEqual(['a:A', 'a:none']);
    expect(shares[1].ratio).toBeNull();
  });

  it('clamps the ratio to 1 as a guard (numerator can never legitimately exceed the base)', () => {
    const shares = authorityShares([
      contract({ authorityId: 'a:A', amountEur: 12_000_000, authorityTotalEur: 10_000_000 }),
    ]);
    expect(shares[0].ratio).toBe(1);
  });

  it('is empty for no contracts', () => {
    expect(authorityShares([])).toEqual([]);
  });
});

describe('authorityShareDisplay', () => {
  const share = (over: Partial<Parameters<typeof authorityShareDisplay>[0]> = {}) => ({
    authorityId: 'a:1',
    authority: 'Община А',
    companyEur: 1_000_000,
    authorityTotalEur: 10_000_000,
    ratio: 0.1,
    inWindow: false,
    contractCount: 1,
    ...over,
  });

  it('plots a bar for a share ≥ 0,1%', () => {
    expect(authorityShareDisplay(share({ ratio: 0.027 }))).toEqual({ mode: 'bar', ratio: 0.027 });
    // exactly 0,1% is still plottable, not tiny
    expect(authorityShareDisplay(share({ ratio: 0.001 }))).toEqual({ mode: 'bar', ratio: 0.001 });
  });

  it('shows „под 0,1%" for a real but sub-0,1% capture — never a fake „0%"', () => {
    // 0,029% (131k of 454.8M — a real row that rounded to „0%" before this fix)
    expect(authorityShareDisplay(share({ ratio: 0.00029 }))).toEqual({ mode: 'tiny' });
  });

  it('drops to the € figure alone when the body has no rollup denominator', () => {
    expect(authorityShareDisplay(share({ ratio: null, authorityTotalEur: null }))).toEqual({
      mode: 'no-denom',
    });
  });

  it('shows neither share nor a fake „0 €" when there is no summable value', () => {
    // companyEur 0 (all amounts were null) → no-value wins even if a ratio somehow computed to 0
    expect(authorityShareDisplay(share({ companyEur: 0, ratio: 0 }))).toEqual({ mode: 'no-value' });
    expect(authorityShareDisplay(share({ companyEur: 0, ratio: null }))).toEqual({
      mode: 'no-value',
    });
  });
});

describe('registryEvidenceLabel', () => {
  // The wording is load-bearing. The register records a ROLE; it does not certify that the official owns
  // anything — that claim comes from their own declaration and is rendered separately. A label that said
  // „собственик според ТР" would assert something the evidence does not support (ADR-0033 decision 2).
  it('reports what the act records, never an ownership conclusion', () => {
    expect(registryEvidenceLabel({ evidenceKind: 'document', registryRole: 'owner' })).toBe(
      'лицето е вписано като съдружник/собственик',
    );
    expect(registryEvidenceLabel({ evidenceKind: 'document', registryRole: 'manager' })).toBe(
      'лицето е вписано като управител',
    );
  });

  it('a seat/ЕИК confirmation claims identity, not a registry role', () => {
    // „Потвърдено" means the COMPANY was identified from something the official declared — nobody was
    // found in the act, so the label must not imply anyone was.
    const label = registryEvidenceLabel({ evidenceKind: 'confirmed', registryRole: null });
    expect(label).toBe('самоличност, потвърдена по декларирани данни');
    expect(label).not.toMatch(/вписан/);
  });

  it('never renders the word „собственик" for a mere confirmation', () => {
    expect(registryEvidenceLabel({ evidenceKind: 'confirmed', registryRole: 'owner' })).not.toMatch(
      /собственик/,
    );
  });
});

describe('groupByPerson', () => {
  // Collapses per-relationship links into one row per PERSON for the /conflicts leaderboard (#287). The DB
  // returns links NEXUS-sorted, but the helper must be correct for ANY input order — it computes the
  // strongest link explicitly and sorts rows itself.

  it('collapses N links for one person into a single row, naming the person once', () => {
    // Same officialSlug, three DISTINCT winners → one row (not three cards). The person appears once.
    const rows = groupByPerson([
      link({ linkKey: 'p:a|1', officialSlug: 'a', official: 'Иван Минев', eik: '1' }),
      link({ linkKey: 'p:a|2', officialSlug: 'a', official: 'Иван Минев', eik: '2' }),
      link({ linkKey: 'p:a|3', officialSlug: 'a', official: 'Иван Минев', eik: '3' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].officialSlug).toBe('a');
    expect(rows[0].official).toBe('Иван Минев');
    expect(rows[0].companyCount).toBe(3);
  });

  it('ranks by the STRONGEST single link, so a strong+weak person outranks a medium-only person', () => {
    // Person A: one STRONG link (own-institution) + one WEAK link (nothing). Person B: one MEDIUM link
    // (has a contemporaneous window, but not own-institution). By strongest-link NEXUS_ORDER, A > B.
    // A naive per-link or flag-OR sort that let A's weak link drag it down would sink A below B — this
    // must go red if the sort becomes per-link rather than strongest-link.
    const rows = groupByPerson([
      // B first in input so a stable/pre-sorted assumption can't accidentally pass the test.
      link({
        linkKey: 'p:b|9',
        officialSlug: 'b',
        official: 'Бета',
        eik: '9',
        ownInstitution: false,
        contemporaneousContractCount: 4,
        contemporaneousValueEur: 3_000_000,
      }),
      link({
        linkKey: 'p:a|weak',
        officialSlug: 'a',
        official: 'Алфа',
        eik: '7',
        ownInstitution: false,
        contemporaneousContractCount: 0,
        contemporaneousValueEur: null,
      }),
      link({
        linkKey: 'p:a|strong',
        officialSlug: 'a',
        official: 'Алфа',
        eik: '8',
        ownInstitution: true,
        contemporaneousContractCount: 1,
        contemporaneousValueEur: 100,
      }),
    ]);
    expect(rows.map((r) => r.officialSlug)).toEqual(['a', 'b']);
    // A's strongest link is own-institution → its rank flag is set; the weak second link does not sink it.
    expect(rows[0].ownInstitution).toBe(true);
  });

  it('does not let two weak links out-rank one strong link (rank ≠ OR-ed flags)', () => {
    // Person C has TWO links: one own-institution (no window), one in-window (no own-institution) — so BOTH
    // row flags are true by OR, yet NEITHER single link carries both. Person D has ONE link that carries both.
    // Correct rank compares the strongest SINGLE link: D's [own+window] dominates either of C's by the FLAG
    // hierarchy (own-institution first, then any-window), independent of €. The buggy rank (from OR-ed row
    // flags) would tie C and D on flags [1,1] and fall to the row's summed window € — so C's window € is set
    // ABOVE D's on purpose: under the bug C would sort FIRST (wrong), so asserting ['d','c'] catches it. The
    // earlier fixture used C-window 1M < D 9M, where the € tiebreak ordered D first under BOTH schemes and the
    // mutation survived (niki #312 HIGH 3).
    const rows = groupByPerson([
      link({
        linkKey: 'p:c|own',
        officialSlug: 'c',
        official: 'Цета',
        eik: '1',
        ownInstitution: true,
        contemporaneousContractCount: 0,
        contemporaneousValueEur: null,
      }),
      link({
        linkKey: 'p:c|window',
        officialSlug: 'c',
        official: 'Цета',
        eik: '2',
        ownInstitution: false,
        contemporaneousContractCount: 5,
        contemporaneousValueEur: 20_000_000, // deliberately ABOVE D's window € — the discriminating value
      }),
      link({
        linkKey: 'p:d|both',
        officialSlug: 'd',
        official: 'Делта',
        eik: '3',
        ownInstitution: true,
        contemporaneousContractCount: 9,
        contemporaneousValueEur: 9_000_000,
      }),
    ]);
    // Strongest-single-link rank → D leads despite C's larger summed window €; an OR-flag rank would put C
    // first. The person-level window € proves the tiebreak did NOT decide the order.
    expect(rows.map((r) => r.officialSlug)).toEqual(['d', 'c']);
    expect(rows[0].contemporaneousValueEur).toBe(9_000_000); // D
    expect(rows[1].contemporaneousValueEur).toBe(20_000_000); // C — larger €, yet ranked second
  });

  it('dedupes public funds per ЕИК: a duplicate-ЕИК link does not double the sum', () => {
    // Two links on the SAME winner (same ЕИК) for one person — total € is company-level (constant within a
    // ЕИК) so it counts once; the window € is a per-link subset so the MAX is taken. Plus a second distinct
    // winner to prove distinct ЕИК DO add.
    const rows = groupByPerson([
      link({
        linkKey: 'p:a|111self',
        officialSlug: 'a',
        eik: '111',
        contractValueEur: 88_000_000,
        contemporaneousValueEur: 40_000_000,
      }),
      link({
        linkKey: 'p:a|111fam',
        officialSlug: 'a',
        eik: '111',
        contractValueEur: 88_000_000,
        contemporaneousValueEur: 25_000_000,
      }),
      link({
        linkKey: 'p:a|222',
        officialSlug: 'a',
        eik: '222',
        contractValueEur: 10_000_000,
        contemporaneousValueEur: 5_000_000,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].contractValueEur).toBe(98_000_000); // 88M once + 10M — NOT 88 + 88 + 10
    expect(rows[0].contemporaneousValueEur).toBe(45_000_000); // max(40M, 25M) for ЕИК 111 + 5M
    expect(rows[0].companyCount).toBe(2); // two distinct winners, despite three links
  });

  it('companyCount counts distinct ЕИК (3 → count); soleCompany carries the name when it is 1', () => {
    const three = groupByPerson([
      link({ linkKey: 'p:a|1', officialSlug: 'a', eik: '1' }),
      link({ linkKey: 'p:a|2', officialSlug: 'a', eik: '2' }),
      link({ linkKey: 'p:a|3', officialSlug: 'a', eik: '3' }),
    ]);
    expect(three[0].companyCount).toBe(3);
    expect(three[0].soleCompany).toBeNull(); // >1 winner → no single name to carry

    const one = groupByPerson([
      link({
        linkKey: 'p:a|9',
        officialSlug: 'a',
        eik: '999',
        company: 'ТРЕЙС ГРУП ХОЛД АД',
      }),
    ]);
    expect(one[0].companyCount).toBe(1);
    expect(one[0].soleCompany).toEqual({ company: 'ТРЕЙС ГРУП ХОЛД АД', eik: '999' });
  });

  it('sets a признак flag sourced only from a SECOND link', () => {
    // The strongest (first) link carries neither flag; a weaker second link carries both. The OR-ed row
    // flags must still be true — a flag on any link surfaces on the row, even one that is not the strongest.
    const rows = groupByPerson([
      link({
        linkKey: 'p:a|lead',
        officialSlug: 'a',
        eik: '1',
        ownInstitution: false,
        contemporaneousContractCount: 0,
      }),
      link({
        linkKey: 'p:a|second',
        officialSlug: 'a',
        eik: '2',
        ownInstitution: true,
        contemporaneousContractCount: 3,
      }),
    ]);
    expect(rows[0].ownInstitution).toBe(true);
    expect(rows[0].hasContemporaneous).toBe(true);
  });

  it('sums contractCount null-guarded — a null/0-contract link never yields NaN', () => {
    const rows = groupByPerson([
      link({ linkKey: 'p:a|1', officialSlug: 'a', eik: '1', contractCount: 5 }),
      // TS types contractCount as number, but a malformed row could arrive null; the guard must hold.
      link({
        linkKey: 'p:a|2',
        officialSlug: 'a',
        eik: '2',
        contractCount: null as unknown as number,
      }),
      link({ linkKey: 'p:a|3', officialSlug: 'a', eik: '3', contractCount: 0 }),
    ]);
    expect(rows[0].contractCount).toBe(5);
    expect(Number.isNaN(rows[0].contractCount)).toBe(false);
  });

  it('dedupes contractCount per ЕИК too — a duplicate-ЕИК link never doubles the count (guardian symmetry)', () => {
    // contract_count is a company-level winner total (constant within a ЕИК), so two links on the SAME ЕИК must
    // count it ONCE — mirroring the money dedup, not a raw link sum (niki #312 MEDIUM 7). Plus a second winner
    // to prove distinct ЕИК DO add.
    const rows = groupByPerson([
      link({ linkKey: 'p:a|111a', officialSlug: 'a', eik: '111', contractCount: 35 }),
      link({ linkKey: 'p:a|111b', officialSlug: 'a', eik: '111', contractCount: 35 }),
      link({ linkKey: 'p:a|222', officialSlug: 'a', eik: '222', contractCount: 4 }),
    ]);
    expect(rows[0].contractCount).toBe(39); // 35 once + 4 — NOT 35 + 35 + 4
  });

  it('is empty for empty input', () => {
    expect(groupByPerson([])).toEqual([]);
  });

  it('keeps namesakes apart: same name, different institution → two rows (group key is person id, not name)', () => {
    // The group key is officialSlug (= personSlug(person_id) = key(name)|key(institution), ADR-0026), NOT the
    // display name — institution is the namesake disambiguator (api-contract). A mutation grouping by `official`
    // would collapse these two distinct office-holders into one row (merging their winners and money under one
    // name). Guard it explicitly: same name, different slug/institution ⇒ two rows (niki #312 MEDIUM 7c).
    const rows = groupByPerson([
      link({
        linkKey: 'p:ivanov-sofia|1',
        officialSlug: 'ivanov-sofia',
        official: 'Иван Иванов',
        institution: 'Община София',
        eik: '111',
      }),
      link({
        linkKey: 'p:ivanov-varna|2',
        officialSlug: 'ivanov-varna',
        official: 'Иван Иванов',
        institution: 'Община Варна',
        eik: '222',
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.officialSlug).sort()).toEqual(['ivanov-sofia', 'ivanov-varna']);
    expect(rows.map((r) => r.institution).sort()).toEqual(['Община Варна', 'Община София']);
  });

  it('carries a family link into the row without exposing any relative identity', () => {
    // A family stake (relation 'related', ADR-0032) folds into the person's counts and money exactly like a
    // self stake — but the row must expose ONLY the official, never the свързано лице. Assert the row shape
    // carries no relative-identity field and the values include the family link's contribution.
    const rows = groupByPerson([
      link({
        linkKey: 'p:a|self',
        officialSlug: 'a',
        official: 'Иван Минев',
        eik: '111',
        relation: 'owns',
        contractCount: 4,
        contractValueEur: 10_000_000,
      }),
      link({
        linkKey: 'p:a|family',
        officialSlug: 'a',
        official: 'Иван Минев',
        eik: '222',
        relation: 'related',
        contractCount: 2,
        contractValueEur: 3_000_000,
      }),
    ]);
    expect(rows).toHaveLength(1);
    // The family link contributed: 2 winners, both contract counts and both € summed.
    expect(rows[0].companyCount).toBe(2);
    expect(rows[0].contractCount).toBe(6);
    expect(rows[0].contractValueEur).toBe(13_000_000);
    // Anonymity: the row shape has ONLY the official's own identity — no relation/relative field of any kind.
    // `stakeKind` is an identity-free enum ('self'|'family'|'mixed'), never a relative name or relationship type.
    expect(rows[0].official).toBe('Иван Минев');
    expect(rows[0].stakeKind).toBe('mixed'); // one own + one family link
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        'companyCount',
        'contemporaneousValueEur',
        'contractCount',
        'contractValueEur',
        'hasContemporaneous',
        'institution',
        'official',
        'officialSlug',
        'ownInstitution',
        'soleCompany',
        'stakeKind',
      ].sort(),
    );
  });

  it('stakeKind: family only when EVERY link is a relative stake; null money stays null (not 0)', () => {
    // family-only person → 'family'; and with no summable € on any winner the row money is NULL, so the cell
    // renders „—" like the per-link card, not a fabricated „0" (niki #312 MEDIUM 1 + MEDIUM 3).
    const family = groupByPerson([
      link({
        linkKey: 'p:f|1',
        officialSlug: 'f',
        relation: 'related',
        eik: '1',
        contractValueEur: null,
        contemporaneousValueEur: null,
        contemporaneousContractCount: 0,
      }),
    ]);
    expect(family[0].stakeKind).toBe('family');
    expect(family[0].contractValueEur).toBeNull();
    expect(family[0].contemporaneousValueEur).toBeNull();
    expect(personFundsCell(family[0]).primary).toBe(moneyBare(null)); // „—", never „0"

    // self-only person → 'self'
    const self = groupByPerson([link({ linkKey: 'p:s|1', officialSlug: 's', relation: 'owns' })]);
    expect(self[0].stakeKind).toBe('self');
  });

  it('preserves the window-null case: in-window contracts with NULL € show total-only, never „0 … от …"', () => {
    // hasContemporaneous is true (a link has an in-window contract) but its window € is NULL, so the row window
    // € must stay NULL and personFundsCell falls back to the total-only shape — the exact case fundsCellLabel
    // guards per link, which a 0-coerced row could not reproduce (niki #312 MEDIUM 3).
    const rows = groupByPerson([
      link({
        linkKey: 'p:a|1',
        officialSlug: 'a',
        eik: '1',
        contemporaneousContractCount: 3,
        contemporaneousValueEur: null,
        contractValueEur: 88_000_000,
      }),
    ]);
    expect(rows[0].hasContemporaneous).toBe(true);
    expect(rows[0].contemporaneousValueEur).toBeNull();
    const cell = personFundsCell(rows[0]);
    expect(cell.primary).toBe(moneyBare(88_000_000));
    expect(cell.total).toBeNull(); // no split — not „0 … от 88 млн."
  });
});

// A winner's contract FACTS as carried in the eager DTO (no temporal — derived per link). Minimal shape.
function facts(over: Partial<ConflictContractFacts> = {}): ConflictContractFacts {
  return {
    contractSlug: 'e:c1',
    signedAt: '2021-05-01',
    authority: 'Община Тест',
    authorityId: 'a:1',
    authorityTotalEur: 5_000_000,
    contractKind: 'Услуги',
    procedureType: 'открита процедура',
    subject: 'Ремонт',
    contractNumber: 'Д-1',
    amountEur: 1_000_000,
    ...over,
  };
}

describe('contractTemporal (per-link window mark, moved client-side #312 HIGH 1)', () => {
  it('marks by inclusive [first, last] against the signing year', () => {
    expect(contractTemporal('2021-05-01', '2019', '2023')).toBe('contemporaneous');
    expect(contractTemporal('2019-01-01', '2019', '2023')).toBe('contemporaneous'); // inclusive lower
    expect(contractTemporal('2023-12-31', '2019', '2023')).toBe('contemporaneous'); // inclusive upper
    expect(contractTemporal('2016-01-01', '2019', '2023')).toBe('before');
    expect(contractTemporal('2024-01-01', '2019', '2023')).toBe('after');
  });

  it("is 'unknown' when the signing date or either declared bound is missing (the branch a mutant would skip)", () => {
    // ydimitrof #312 MEDIUM 4: without the null guards, `null < lo` is `true` and an undated contract would
    // silently read as „before". Pin all three missing-input paths to 'unknown'.
    expect(contractTemporal(null, '2019', '2023')).toBe('unknown'); // no signing date
    expect(contractTemporal('2021-05-01', null, '2023')).toBe('unknown'); // no lower bound
    expect(contractTemporal('2021-05-01', '2019', null)).toBe('unknown'); // no upper bound
    expect(contractTemporal(null, null, null)).toBe('unknown');
  });

  it("treats a non-ISO / bogus date as 'unknown' (the >0 guard, matching strftime returning NULL)", () => {
    // parseYear's `> 0` guard: a non-ISO date yields no valid year → 'unknown', NOT 'before'. This is the
    // divergence from `strftime('%Y', …)` ydimitrof #312 MEDIUM 4 flagged; both now agree on „no year".
    expect(contractTemporal('not-a-date', '2019', '2023')).toBe('unknown');
    expect(contractTemporal('0000-01-01', '2019', '2023')).toBe('unknown');
  });
});

describe('markContracts (derive per-link temporal + contemporaneous-first)', () => {
  it('marks a winner’s shared facts against ONE link’s window and sorts in-window first', () => {
    const shared = [
      facts({ contractSlug: 'e:out', contractNumber: 'Д-3', signedAt: '2024-01-01' }), // after
      facts({ contractSlug: 'e:in', contractNumber: 'Д-1', signedAt: '2020-01-01' }), // in-window
      facts({ contractSlug: 'e:un', contractNumber: 'Д-4', signedAt: null }), // unknown
    ];
    const marked = markContracts(shared, '2019', '2023');
    // contemporaneous first, then the rest in their read order (stable)
    expect(marked.map((c) => [c.contractNumber, c.temporal])).toEqual([
      ['Д-1', 'contemporaneous'],
      ['Д-3', 'after'],
      ['Д-4', 'unknown'],
    ]);
  });

  it('marks the SAME shared facts differently for two links with different windows (the dedup payoff)', () => {
    const shared = [facts({ signedAt: '2021-05-01' })];
    // one official’s window includes 2021, another’s does not — same facts, different split
    expect(markContracts(shared, '2019', '2023')[0]!.temporal).toBe('contemporaneous');
    expect(markContracts(shared, '2010', '2014')[0]!.temporal).toBe('after');
  });
});
