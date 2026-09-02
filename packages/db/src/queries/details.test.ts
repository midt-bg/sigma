import { describe, expect, it } from 'vitest';
import { fakeD1 } from '@sigma/test-support';
import { getAuthority, getCompany, getContract } from './details';

const baseContractRow = {
  id: 'c:1',
  tender_id: 't:UNP-1',
  contract_subject: 'Contract subject' as string | null,
  contract_number: null as string | null,
  document_number: null,
  lot_id: 'lot:UNP-1:1' as string | null,
  signed_at: '2024-01-15',
  published_at: '2024-01-16',
  contract_kind: 'services',
  eu_funded: 0 as number | null,
  eu_programme: null,
  duration_days: null,
  amount_eur: 5000,
  signing_value: 5000 as number | null,
  current_value: null as number | null,
  fx_rate: null as number | null,
  signing_value_eur: 5000 as number | null,
  current_value_eur: null as number | null,
  value_flag: 'ok' as string,
  date_flag: 'ok',
  bids_received: 2,
  bids_rejected: 0,
  bids_sme: 1,
  bids_non_eea: 0,
  subcontractor_eik: null as string | null,
  subcontractor_name: null as string | null,
  subcontract_value: null as number | null,
  contract_currency: 'EUR',
  title: 'Tender subject',
  unp: 'UNP-1',
  procedure_type: 'Открита процедура',
  cpv_code: '72000000' as string | null,
  cpv_description: 'IT services',
  num_lots: 2 as number | null,
  tender_awards: 1 as number,
  eop_tender_id: null as string | null,
  estimated_value: 10000,
  tender_currency: 'EUR' as string | null,
  tender_fx_rate: null as number | null,
  start_date: null,
  end_date: null,
  authority_id: 'auth:123456786',
  authority_name: 'Authority',
  // c.ordering_unit_name — the unit named ON the document, which may or may not be the authority itself.
  source_authority_name: null as string | null,
  authority_type_group: 'ministry',
  authority_settlement: 'Sofia',
  bidder_id: 'eik:111111113',
  bidder_name: 'Bidder',
  bidder_kind: 'company' as const,
  bidder_eik: '111111113',
  bidder_settlement: 'Sofia',
};

function fakeDb(
  contractRow: typeof baseContractRow,
  lotRows: unknown[],
  amendmentRows: unknown[] = [],
  cohortStatsRow: object | null = null,
): D1Database {
  return fakeD1([
    { when: 'WHERE c.id = ?', first: contractRow },
    { when: 'authority_totals', first: null },
    { when: 'company_totals', first: null },
    // The „Подобни договори" cohort lookup — null unless the test supplies a stats row.
    { when: 'cpv_division_stats', first: cohortStatsRow },
    {
      when: 'FROM lots l',
      all: (call) => {
        expect(call.binds).toEqual([contractRow.tender_currency, contractRow.tender_id]);
        return lotRows;
      },
    },
    {
      when: 'FROM amendments',
      all: (call) => {
        expect(call.binds).toEqual([contractRow.unp, contractRow.contract_number]);
        return amendmentRows;
      },
    },
  ]).db;
}

describe('getContract', () => {
  it('uses the tender currency for lot estimated values', async () => {
    const detail = await getContract(
      fakeDb(baseContractRow, [
        {
          lot_id: 'lot:UNP-1:1',
          title: 'Lot 1',
          estimated_value: 5000,
          estimated_currency: 'EUR',
          cpv_code: null,
          contract_id: 'c:1',
          signing_value_eur: 5000,
          estimated_fx_rate: null,
          bidder_name: 'Bidder',
          bidder_kind: 'company',
          bidder_id: 'eik:111111113',
        },
        {
          lot_id: 'lot:UNP-1:2',
          title: 'Lot 2',
          estimated_value: 7000,
          estimated_currency: 'EUR',
          cpv_code: null,
          contract_id: null,
          signing_value_eur: null,
          estimated_fx_rate: null,
          bidder_name: null,
          bidder_kind: null,
          bidder_id: null,
        },
      ]),
      'c:1',
    );

    expect(detail?.value.estimatedEur).toBe(5000);
    expect(detail?.value.procedureEstimatedEur).toBe(10000);
    expect(detail?.lots?.rows.map((r) => r.estimatedEur)).toEqual([5000, 7000]);
    expect(detail?.lots?.estimatedTotalEur).toBe(12000);
  });

  it('re-sorts lexically-collated lot labels numerically (1, 2 … 10, not 1, 10, 2)', async () => {
    // SQL ORDER BY l.id collates the lot id as text, so multi-digit labels arrive lexically
    // (10, 2, 1). The numeric-aware comparator must restore 1, 2, 10 — a plain localeCompare would
    // give 1, 10, 2 and dropping the sort would leave 10, 2, 1, so only the numeric sort passes.
    const lot = (n: string) => ({
      lot_id: `lot:UNP-1:${n}`,
      title: `Lot ${n}`,
      estimated_value: null,
      estimated_currency: 'EUR',
      cpv_code: null,
      contract_id: null,
      signing_value_eur: null,
      estimated_fx_rate: null,
      bidder_name: null,
      bidder_kind: null,
      bidder_id: null,
    });
    const detail = await getContract(
      fakeDb(baseContractRow, [lot('10'), lot('2'), lot('1')]),
      'c:1',
    );
    expect(detail?.lots?.rows.map((r) => r.lotLabel)).toEqual(['1', '2', '10']);
  });

  it('collapses a consortium lot contractor name via the row kind', async () => {
    // bidder_kind 'consortium' + a ';'-joined name must flow into entityName so the lot row shows
    // „А и др." — a mutation that ignored the row kind would leave the raw joined string.
    const detail = await getContract(
      fakeDb(baseContractRow, [
        {
          lot_id: 'lot:UNP-1:1',
          title: 'Lot 1',
          estimated_value: null,
          estimated_currency: 'EUR',
          cpv_code: null,
          contract_id: null,
          signing_value_eur: null,
          estimated_fx_rate: null,
          bidder_name: 'А ООД; Б ЕООД',
          bidder_kind: 'consortium',
          bidder_id: 'eik:111111111',
        },
      ]),
      'c:1',
    );
    expect(detail?.lots?.rows[0]?.contractorName).toBe('А ООД и др.');
  });

  it('defaults a lot with no currency (and no tender currency) to the BGN peg', async () => {
    // estimated_currency ?? tender_currency is null → eurFromNative applies `currency || 'BGN'` and
    // converts via the peg (1.95583), so 1955.83 BGN → ~1000 EUR.
    const detail = await getContract(
      fakeDb({ ...baseContractRow, tender_currency: null }, [
        {
          lot_id: 'lot:UNP-1:1',
          title: 'Lot 1',
          estimated_value: 1955.83,
          estimated_currency: null,
          cpv_code: null,
          contract_id: 'c:1',
          signing_value_eur: null,
          estimated_fx_rate: null,
          bidder_name: 'Bidder',
          bidder_kind: 'company',
          bidder_id: 'eik:111111111',
        },
      ]),
      'c:1',
    );
    expect(detail?.lots?.rows[0]?.estimatedEur).toBeCloseTo(1000, 0);
    expect(detail?.lots?.rows[0]?.lotLabel).toBe('1');
  });

  it('uses FX rates for foreign-currency estimated values when available', async () => {
    const usdContractRow = {
      ...baseContractRow,
      tender_currency: 'USD',
      tender_fx_rate: 0.9,
    };

    const detail = await getContract(
      fakeDb(usdContractRow, [
        {
          lot_id: 'lot:UNP-1:1',
          title: 'Lot 1',
          estimated_value: 5000,
          estimated_currency: 'USD',
          cpv_code: null,
          contract_id: 'c:1',
          signing_value_eur: 4500,
          estimated_fx_rate: 0.9,
          bidder_name: 'Bidder',
          bidder_kind: 'company',
          bidder_id: 'eik:111111113',
        },
        {
          lot_id: 'lot:UNP-1:2',
          title: 'Lot 2',
          estimated_value: 7000,
          estimated_currency: 'USD',
          cpv_code: null,
          contract_id: null,
          signing_value_eur: null,
          estimated_fx_rate: null,
          bidder_name: null,
          bidder_kind: null,
          bidder_id: null,
        },
      ]),
      'c:1',
    );

    expect(detail?.value.estimatedEur).toBe(4500);
    expect(detail?.value.procedureEstimatedEur).toBe(9000);
    expect(detail?.lots?.rows.map((r) => r.estimatedEur)).toEqual([4500, null]);
    expect(detail?.lots?.estimatedTotalEur).toBe(4500);
  });

  it('keeps display values visible for unverified value flags', async () => {
    for (const flag of ['value_suspect', 'annex_suspect', 'review']) {
      const detail = await getContract(
        fakeDb(
          {
            ...baseContractRow,
            signing_value: 256.49,
            current_value: flag === 'annex_suspect' ? 1025.96 : null,
            signing_value_eur: flag === 'value_suspect' ? null : 256.49,
            current_value_eur: null,
            value_flag: flag,
          },
          [],
        ),
        'c:1',
      );

      expect(detail?.value.suspect).toBe(true);
      expect(detail?.value.signingEur).toBe(256.49);
      expect(detail?.value.currentEur).toBe(flag === 'annex_suspect' ? 1025.96 : 256.49);
      expect(detail?.value.currentValueDoubled).toBe(false);
    }
  });

  it('#307 blanks the current value for a KNOWN 2× double-count (annex_total_suspect)', async () => {
    const detail = await getContract(
      fakeDb(
        {
          ...baseContractRow,
          signing_value: 256.49,
          current_value: 512.98, // the doubled native figure — must NOT resurface
          signing_value_eur: 256.49,
          current_value_eur: null, // excluded from aggregates upstream
          value_flag: 'annex_total_suspect',
        },
        [],
      ),
      'c:1',
    );

    expect(detail?.value.suspect).toBe(true);
    expect(detail?.value.currentValueDoubled).toBe(true);
    // Blanked (—), never the doubled 512.98 nor a fabricated fallback.
    expect(detail?.value.currentEur).toBeNull();
    expect(detail?.value.deltaPct).toBeNull();
    // The trustworthy signing value is still shown.
    expect(detail?.value.signingEur).toBe(256.49);
  });

  // Exercises the real cohort path end-to-end (baseContractRow is clean-value, CPV '72', amount 5000).
  // Guards the argument order into contractCohort: swapping value_flag ↔ division would make it return
  // null and this would fail.
  it('populates the cohort from a real cpv_division_stats row', async () => {
    const statsRow = {
      division: '72',
      priced_contracts: 200,
      p25_eur: 1000,
      median_eur: 4000,
      p75_eur: 10_000,
      p90_eur: 40_000,
      p95_eur: 90_000,
      p99_eur: 400_000,
    };
    const detail = await getContract(fakeDb(baseContractRow, [], [], statsRow), 'c:1');

    expect(detail?.cohort).not.toBeNull();
    expect(detail?.cohort?.amountEur).toBe(5000); // the contract's own amount_eur, not a stats field
    expect(detail?.cohort?.stats.division).toBe('72');
    expect(detail?.cohort?.stats.pricedContracts).toBe(200);
    expect(detail?.cohort?.band).toBe('above-median'); // 5000 > median 4000, < p75 10000
  });

  // The read is gated on a clean value: a suspect contract must NOT even query cpv_division_stats.
  it('skips the cohort read (and returns no cohort) for a non-clean value', async () => {
    // No cpv_division_stats route at all: were the read to happen, the double would reject rather
    // than quietly answer, so the assertion below cannot pass for the wrong reason.
    const fake = fakeD1([
      { when: 'WHERE c.id = ?', first: { ...baseContractRow, value_flag: 'value_suspect' } },
      { when: 'authority_totals', first: null },
      { when: 'company_totals', first: null },
      { when: 'FROM lots l', all: [] },
      { when: 'FROM amendments', all: [] },
    ]);

    const detail = await getContract(fake.db, 'c:1');

    expect(detail?.cohort).toBeNull();
    expect(fake.sql.some((sql) => sql.includes('cpv_division_stats'))).toBe(false);
  });

  it('recomputes delta from before/after (ignoring a disagreeing source delta) and trims text', async () => {
    const detail = await getContract(
      fakeDb(
        { ...baseContractRow, contract_number: 'C-1' },
        [],
        [
          {
            value_before: 1000,
            value_after: 1200,
            value_delta: 999, // dirty source: disagrees with after − before; the computed value wins
            currency: 'EUR',
            published_at: '2024-03-01',
            document_number: 'A1',
            description: '  Удължаване на срока  ',
            fx_rate: null,
          },
          {
            value_before: 1200,
            value_after: 1500,
            value_delta: null, // missing → derived from before/after
            currency: 'EUR',
            published_at: '2024-06-01',
            document_number: 'A2',
            description: null,
            fx_rate: null,
          },
        ],
      ),
      'c:1',
    );

    expect(detail?.amendments).toHaveLength(2);
    expect(detail?.amendments[0]).toMatchObject({
      date: '2024-03-01',
      documentNumber: 'A1',
      valueAfterEur: 1200,
      deltaEur: 200, // 1200 − 1000, NOT the source's 999
      description: 'Удължаване на срока', // trimmed
    });
    expect(detail?.amendments[1]).toMatchObject({
      valueAfterEur: 1500,
      deltaEur: 300, // derived 1500 − 1200
      description: null,
    });
  });

  it('shows „—" for delta when only one of before/after is present, even if the source has a raw value_delta', async () => {
    const detail = await getContract(
      fakeDb(
        { ...baseContractRow, contract_number: 'C-5' },
        [],
        [
          {
            value_before: null, // unknown before-value → can't reconcile after − before
            value_after: 1200,
            value_delta: 999, // would be self-inconsistent against valueAfterEur if shown
            currency: 'EUR',
            published_at: '2024-03-01',
            document_number: 'A1',
            description: null,
            fx_rate: null,
          },
        ],
      ),
      'c:1',
    );

    expect(detail?.amendments[0]).toMatchObject({
      valueAfterEur: 1200,
      deltaEur: null, // renders „—" rather than a value that can't be reconciled
    });
  });

  it('shows „—" for a value-less annex (null value_after) and a null delta', async () => {
    const detail = await getContract(
      fakeDb(
        { ...baseContractRow, contract_number: 'C-4' },
        [],
        [
          {
            value_before: null,
            value_after: null, // a description-only annex, e.g. a deadline extension
            value_delta: null,
            currency: 'EUR',
            published_at: '2024-03-01',
            document_number: 'A1',
            description: 'Удължаване на срока',
            fx_rate: null,
          },
        ],
      ),
      'c:1',
    );

    expect(detail?.amendments[0]).toMatchObject({
      valueAfterEur: null, // renders „—"
      deltaEur: null,
      description: 'Удължаване на срока',
    });
  });

  it('#305 residual: suppresses value_after and delta for a suspect (uncorrectable double-count) annex', async () => {
    const detail = await getContract(
      fakeDb(
        { ...baseContractRow, contract_number: 'C-6' },
        [],
        [
          {
            value_before: 1000,
            value_after: 3000, // the source's untrusted doubled/tripled total
            value_delta: 2000,
            currency: 'EUR',
            published_at: '2024-03-01',
            document_number: 'A1',
            description: 'Изменение на стойността',
            value_restated: 0,
            value_suspect: 1,
            fx_rate: null,
          },
        ],
      ),
      'c:1',
    );

    expect(detail?.amendments[0]).toMatchObject({
      valueAfterEur: null, // suppressed — we don't stand behind the doubled figure
      deltaEur: null,
      suspect: true,
      restated: false,
      description: 'Изменение на стойността', // description still shown
    });
  });

  it('converts foreign-currency amendments to EUR via the annex fx rate', async () => {
    const detail = await getContract(
      fakeDb(
        { ...baseContractRow, contract_number: 'C-2' },
        [],
        [
          {
            value_before: 1000,
            value_after: 2000,
            value_delta: 1000,
            currency: 'USD',
            published_at: '2024-03-01',
            document_number: 'A1',
            description: null,
            fx_rate: 0.9,
          },
        ],
      ),
      'c:1',
    );

    expect(detail?.amendments[0]).toMatchObject({
      valueAfterEur: 1800,
      deltaEur: 900,
    });
  });

  it('normalises BGN amendment values via the fixed peg', async () => {
    const detail = await getContract(
      fakeDb(
        { ...baseContractRow, contract_number: 'C-3' },
        [],
        [
          {
            value_before: 1955.83,
            value_after: 3911.66,
            value_delta: 1955.83,
            currency: 'BGN',
            published_at: '2024-03-01',
            document_number: 'A1',
            description: null,
            fx_rate: null,
          },
        ],
      ),
      'c:1',
    );

    const a0 = detail?.amendments[0];
    expect(a0?.valueAfterEur ?? 0).toBeCloseTo(2000, 6); // 3911.66 / 1.95583
    expect(a0?.deltaEur ?? 0).toBeCloseTo(1000, 6); // (3911.66 − 1955.83) / 1.95583
  });

  it('has no amendment history when the contract has no annexes', async () => {
    const detail = await getContract(fakeDb(baseContractRow, []), 'c:1');
    expect(detail?.amendments).toEqual([]);
  });
});

// ── getCompany ──────────────────────────────────────────────────────────────────────────────────
const companyRow = {
  bidder_id: 'eik:111111111',
  name: 'ТЕСТ ООД',
  kind: 'company' as 'company' | 'consortium',
  ownership_kind: null as string | null,
  eik: '111111111',
  eik_valid: 1,
  settlement: 'София',
  won_eur: 100000,
  contracts: 12,
  authorities: 4,
  primary_sector: '45',
  eu_eur: 25000,
  first_date: '2021-01-01',
  last_date: '2024-06-01',
};

function companyDb(
  row: typeof companyRow | null,
  extra: { primary_eur: number | null; avg_bids: number | null } | null = {
    primary_eur: 60000,
    avg_bids: 2.34,
  },
): D1Database {
  return fakeD1([
    { when: 'FROM company_totals', first: row },
    { when: 'nuts_regions', first: { legal_form: 'ООД', region: 'София' } },
    { when: 'AS primary_eur', first: extra },
    { when: 'four_plus', first: { one: 1, two: 2, three: 0, four_plus: 1, unknown: 0 } },
    { when: ['COUNT(*) AS n', 'amount_eur IS NULL'], first: { n: 3 } },
    {
      when: 'AS paid',
      all: [
        { authority_id: 'auth:1', name: 'Общ 1', paid: 60000, n: 6 },
        { authority_id: 'auth:2', name: 'Общ 2', paid: 40000, n: 6 },
      ],
    },
    {
      when: ['GROUP BY t.procedure_type', 'c.bidder_id'],
      all: [{ procedure_type: 'Открита процедура', n: 10, eur: 90000 }],
    },
    // Both detail pages render a contracts panel through listContracts: its page read and the
    // COUNT/SUM aggregate that accompanies it. Empty here; nothing in this file asserts on them.
    { when: 'COALESCE(NULLIF(c.contract_subject', all: [] },
    { when: 'COUNT(*) AS total', first: { total: 0, eur: 0, suspect: 0 } },
  ]).db;
}

describe('getCompany', () => {
  it('returns null when the company is not found', async () => {
    expect(await getCompany(companyDb(null), 'eik:x')).toBeNull();
  });

  it('assembles the company DTO with shares, bids, and rounded average', async () => {
    const d = (await getCompany(companyDb(companyRow), 'eik:111111111'))!;
    expect(d.slug).toBe('111111111');
    expect(d.hasEik).toBe(true);
    expect(d.wonEur).toBe(100000);
    expect(d.euSharePct).toBeCloseTo(0.25); // 25000 / 100000
    expect(d.sectorSharePct).toBeCloseTo(0.6); // primary_eur 60000 / 100000
    expect(d.avgBids).toBe(2.3); // 2.34 rounded to 1dp
    expect(d.suspect).toBe(3);
    expect(d.topAuthorities[0]).toMatchObject({ slug: '1', paidEur: 60000, contracts: 6 });
    expect(d.topAuthorities[0]!.sharePct).toBeCloseTo(0.6);
    expect(d.moreAuthorities).toBe(2); // authorities 4 − 2 listed
    expect(d.bids).toEqual({ one: 1, two: 2, three: 0, fourPlus: 1, unknown: 0 });
    // Single procedure group (n:10, eur:90000, total 90000) → contracts/valueEur folded through and
    // sharePct = 90000/90000. Asserting the shape, not just non-empty, guards toProcedureMix's fields.
    expect(d.procedureMix[0]).toMatchObject({ contracts: 10, valueEur: 90000, sharePct: 1 });
    expect(d.participants).toEqual([]); // plain company → no participants
  });

  it('nulls sector share and average when the aggregate row is empty', async () => {
    const d = (await getCompany(companyDb(companyRow, null), 'eik:111111111'))!;
    expect(d.sectorSharePct).toBeNull();
    expect(d.avgBids).toBeNull();
  });

  it('falls back to zero shares when the company has won nothing', async () => {
    const d = (await getCompany(companyDb({ ...companyRow, won_eur: 0 }), 'eik:111111111'))!;
    expect(d.euSharePct).toBe(0);
    expect(d.sectorSharePct).toBeNull();
    expect(d.topAuthorities[0]!.sharePct).toBe(0);
  });

  it('parses a consortium member list into participants', async () => {
    const d = (await getCompany(
      companyDb({ ...companyRow, kind: 'consortium', name: 'А ООД; Б ЕООД; В АД' }),
      'eik:111111111',
    ))!;
    expect(d.isConsortium).toBe(true);
    expect(d.participants.map((p) => p.name)).toEqual(['А ООД', 'Б ЕООД', 'В АД']);
    expect(d.participants.every((p) => p.eik === null && p.resolvedSlug === null)).toBe(true);
    expect(d.membershipNote).toBeNull();
  });

  it('keeps a prose consortium string as a membership note, not participants', async () => {
    const d = (await getCompany(
      companyDb({ ...companyRow, kind: 'consortium', name: 'съдружници са следните лица: ...' }),
      'eik:111111111',
    ))!;
    expect(d.participants).toEqual([]);
    expect(d.membershipNote).toContain('съдружници');
  });

  it('marks hasEik false when the ЕИК is not validated', async () => {
    const d = (await getCompany(companyDb({ ...companyRow, eik_valid: 0 }), 'eik:111111111'))!;
    expect(d.hasEik).toBe(false);
    expect(d.eikValid).toBe(false);
  });

  it('fills every fallback when metadata/bids/suspect rows and the procedure value are absent', async () => {
    // Exercises the `?? null`/`?? 0` fallbacks: null bidderMeta, null bidsRow, null suspectRow,
    // a null primary_sector (bound as ''), and a procedure row whose value is NULL.
    const row = { ...companyRow, primary_sector: null };
    const db = fakeD1([
      { when: 'FROM company_totals', first: row },
      { when: 'nuts_regions', first: null }, // bidderMeta null
      { when: 'AS primary_eur', first: null }, // extra null
      { when: 'four_plus', first: null }, // bidsRow null
      { when: ['COUNT(*) AS n', 'amount_eur IS NULL'], first: null }, // suspectRow null
      { when: 'AS paid', all: [] },
      {
        when: ['GROUP BY t.procedure_type', 'c.bidder_id'],
        all: [{ procedure_type: 'Открита процедура', n: 1, eur: null }],
      },
      // listContracts panel — see companyDb/authorityDb above.
      { when: 'COALESCE(NULLIF(c.contract_subject', all: [] },
      { when: 'COUNT(*) AS total', first: { total: 0, eur: 0, suspect: 0 } },
    ]).db;
    const d = (await getCompany(db, 'eik:111111111'))!;
    expect(d.region).toBeNull();
    expect(d.legalForm).toBeNull();
    expect(d.bids).toEqual({ one: 0, two: 0, three: 0, fourPlus: 0, unknown: 0 });
    expect(d.suspect).toBe(0);
    expect(d.sectorSharePct).toBeNull();
    expect(d.avgBids).toBeNull();
    expect(d.procedureMix).toEqual([]); // null proc value → group valueEur 0 → dropped
  });
});

// ── getAuthority ────────────────────────────────────────────────────────────────────────────────
const authorityRow = {
  authority_id: 'auth:123456789',
  name: 'Министерство',
  type_group: 'министерство' as string | null,
  settlement: 'София',
  region: 'Столична',
  spent_eur: 200000,
  contracts: 40,
  suppliers: 10,
  avg_eur: 5000,
  primary_sector: '45',
  eu_eur: 50000,
  first_date: '2020-01-01',
  last_date: '2024-12-31',
};

function authorityDb(
  row: typeof authorityRow | null,
  sectorRows: { division: string; eur: number }[] = [{ division: '45', eur: 120000 }],
): D1Database {
  return fakeD1([
    { when: 'FROM authority_totals', first: row },
    { when: 'AVG(c.bids_received)', first: { avg_bids: 3.16 } },
    { when: ['COUNT(*) AS n', 'amount_eur IS NULL'], first: { n: 2 } },
    {
      when: 'ORDER BY won DESC',
      all: [
        { bidder_id: 'eik:1', name: 'A ООД', kind: 'company', won: 120000, n: 8 },
        { bidder_id: 'eik:2', name: 'Б АД', kind: 'company', won: 80000, n: 5 },
      ],
    },
    { when: 'GROUP BY division', all: sectorRows },
    {
      when: 'GROUP BY t.procedure_type',
      all: [{ procedure_type: 'Пряко договаряне', n: 4, eur: 60000 }],
    },
    // Both detail pages render a contracts panel through listContracts: its page read and the
    // COUNT/SUM aggregate that accompanies it. Empty here; nothing in this file asserts on them.
    { when: 'COALESCE(NULLIF(c.contract_subject', all: [] },
    { when: 'COUNT(*) AS total', first: { total: 0, eur: 0, suspect: 0 } },
  ]).db;
}

describe('getAuthority', () => {
  it('returns null when the authority is not found', async () => {
    expect(await getAuthority(authorityDb(null), 'auth:x')).toBeNull();
  });

  it('assembles the authority DTO with contractor + sector shares', async () => {
    const d = (await getAuthority(authorityDb(authorityRow), 'auth:123456789'))!;
    expect(d.eik).toBe('123456789');
    expect(d.spentEur).toBe(200000);
    expect(d.euSharePct).toBeCloseTo(0.25);
    expect(d.avgBids).toBe(3.2); // 3.16 → 3.2
    expect(d.suspect).toBe(2);
    expect(d.topContractors[0]).toMatchObject({ slug: '1', wonEur: 120000, contracts: 8 });
    expect(d.topContractors[0]!.sharePct).toBeCloseTo(0.6);
    expect(d.moreContractors).toBe(8); // suppliers 10 − 2 listed
    expect(d.sectors[0]).toMatchObject({ code: '45', valueEur: 120000 });
    expect(d.sectorsOther).toBeNull(); // only one sector, no tail
    // Single procedure group (n:4, eur:60000, total 60000) → sharePct = 60000/60000. Shape assertion
    // guards toProcedureMix's contracts/valueEur/sharePct against a coverage-only mutation.
    expect(d.procedureMix[0]).toMatchObject({ contracts: 4, valueEur: 60000, sharePct: 1 });
  });

  it('rolls sectors beyond the top 6 into a „… още" tail bucket', async () => {
    const rows = [
      { division: '45', eur: 70000 },
      { division: '33', eur: 40000 },
      { division: '15', eur: 30000 },
      { division: '09', eur: 20000 },
      { division: '48', eur: 15000 },
      { division: '72', eur: 10000 },
      { division: '34', eur: 5000 }, // 7th → tail
      { division: '90', eur: 3000 }, // 8th → tail
    ];
    const d = (await getAuthority(authorityDb(authorityRow, rows), 'auth:123456789'))!;
    expect(d.sectors).toHaveLength(6);
    expect(d.sectorsOther).not.toBeNull();
    expect(d.sectorsOther!.valueEur).toBe(8000); // 5000 + 3000
    expect(d.sectorsOther!.label).toContain('още');
  });

  it('falls back to zero shares when the authority has spent nothing', async () => {
    const d = (await getAuthority(
      authorityDb({ ...authorityRow, spent_eur: 0 }),
      'auth:123456789',
    ))!;
    expect(d.euSharePct).toBe(0);
    expect(d.topContractors[0]!.sharePct).toBe(0);
    expect(d.sectors[0]!.sharePct).toBe(0);
  });

  it('spent-nothing authority: drops an unknown sector, zeroes the tail share, nulls absent bids/suspect', async () => {
    const sectorRows = [
      { division: '45', eur: 70000 },
      { division: '33', eur: 40000 },
      { division: '15', eur: 30000 },
      { division: '09', eur: 20000 },
      { division: '48', eur: 15000 },
      { division: '72', eur: 10000 },
      { division: '34', eur: 5000 }, // 7th valid → tail
      { division: 'XX', eur: 3000 }, // unknown CPV division → sectorRef null → filtered out
    ];
    const db = fakeD1([
      { when: 'FROM authority_totals', first: { ...authorityRow, spent_eur: 0 } },
      { when: 'AVG(c.bids_received)', first: { avg_bids: null } }, // avgBids null
      { when: ['COUNT(*) AS n', 'amount_eur IS NULL'], first: null }, // suspectRow null → 0
      {
        when: 'ORDER BY won DESC',
        all: [{ bidder_id: 'eik:1', name: 'A ООД', kind: 'company', won: 1, n: 1 }],
      },
      { when: 'GROUP BY division', all: sectorRows },
      { when: 'GROUP BY t.procedure_type', all: [] },
      // listContracts panel — see companyDb/authorityDb above.
      { when: 'COALESCE(NULLIF(c.contract_subject', all: [] },
      { when: 'COUNT(*) AS total', first: { total: 0, eur: 0, suspect: 0 } },
    ]).db;
    const d = (await getAuthority(db, 'auth:123456789'))!;
    expect(d.avgBids).toBeNull();
    expect(d.suspect).toBe(0);
    expect(d.sectors).toHaveLength(6); // 7 valid sectors → 6 shown + tail
    expect(d.sectors.some((s) => s.code === 'XX')).toBe(false); // unknown division dropped
    expect(d.sectorsOther).not.toBeNull();
    expect(d.sectorsOther!.sharePct).toBe(0); // spent_eur 0 → 0
  });
});

describe('getContract — subcontractor, framework, currency, and field branches', () => {
  it('keeps an EUR subcontractor value as-is and normalises a BGN one via the peg', async () => {
    const eur = (await getContract(
      fakeDb(
        {
          ...baseContractRow,
          subcontractor_name: 'Под ООД',
          subcontractor_eik: '9',
          subcontract_value: 1000,
          contract_currency: 'EUR',
        },
        [],
      ),
      'c:1',
    ))!;
    expect(eur.subcontractor).toMatchObject({ name: 'Под ООД', eik: '9', valueEur: 1000 });
    const bgn = (await getContract(
      fakeDb(
        {
          ...baseContractRow,
          subcontractor_name: 'Под',
          subcontract_value: 1955.83,
          contract_currency: 'BGN',
        },
        [],
      ),
      'c:1',
    ))!;
    expect(bgn.subcontractor!.valueEur).toBeCloseTo(1000);
  });

  it('nulls a subcontractor value when unknown and drops a blank-named subcontractor', async () => {
    const noVal = (await getContract(
      fakeDb({ ...baseContractRow, subcontractor_name: 'Под', subcontract_value: null }, []),
      'c:1',
    ))!;
    expect(noVal.subcontractor!.valueEur).toBeNull();
    const blank = (await getContract(
      fakeDb({ ...baseContractRow, subcontractor_name: '   ' }, []),
      'c:1',
    ))!;
    expect(blank.subcontractor).toBeNull();
  });

  it('flags framework call-offs only when awards exceed the lot count', async () => {
    const fw = (await getContract(
      fakeDb({ ...baseContractRow, tender_awards: 5, num_lots: 2 }, []),
      'c:1',
    ))!;
    expect(fw.frameworkAwards).toBe(5);
    const notFw = (await getContract(
      fakeDb({ ...baseContractRow, tender_awards: 2, num_lots: 2 }, []),
      'c:1',
    ))!;
    expect(notFw.frameworkAwards).toBeNull();
  });

  it('relabels the unknown procedure and maps eu funding tri-state', async () => {
    const unknown = (await getContract(
      fakeDb({ ...baseContractRow, procedure_type: 'неизвестна', eu_funded: null }, []),
      'c:1',
    ))!;
    expect(unknown.procedureLabel).toBe('Неизвестна');
    expect(unknown.euFunded).toBeNull();
    const funded = (await getContract(fakeDb({ ...baseContractRow, eu_funded: 1 }, []), 'c:1'))!;
    expect(funded.euFunded).toBe(true);
  });

  it('falls back to the tender title for a blank subject and nulls lotLabel when no lot', async () => {
    const d = (await getContract(
      fakeDb({ ...baseContractRow, contract_subject: null, lot_id: null }, []),
      'c:1',
    ))!;
    expect(d.subject).toBe('Tender subject');
    expect(d.lotLabel).toBeNull();
  });

  it('converts native signing values by currency when no *_eur column is present', async () => {
    const bgn = (await getContract(
      fakeDb(
        {
          ...baseContractRow,
          signing_value_eur: null,
          signing_value: 1955.83,
          contract_currency: 'BGN',
        },
        [],
      ),
      'c:1',
    ))!;
    expect(bgn.value.signingEur).toBeCloseTo(1000);
    const usd = (await getContract(
      fakeDb(
        {
          ...baseContractRow,
          signing_value_eur: null,
          signing_value: 100,
          contract_currency: 'USD',
          fx_rate: 0.9,
        },
        [],
      ),
      'c:1',
    ))!;
    expect(usd.value.signingEur).toBeCloseTo(90);
    const noFx = (await getContract(
      fakeDb(
        {
          ...baseContractRow,
          signing_value_eur: null,
          signing_value: 100,
          contract_currency: 'USD',
          fx_rate: null,
        },
        [],
      ),
      'c:1',
    ))!;
    expect(noFx.value.signingEur).toBeNull();
  });

  it('computes deltaPct for a clean contract but suppresses it for a suspect flag or zero base', async () => {
    const clean = (await getContract(
      fakeDb(
        { ...baseContractRow, signing_value_eur: 5000, current_value_eur: 6000, value_flag: 'ok' },
        [],
      ),
      'c:1',
    ))!;
    expect(clean.value.deltaPct).toBeCloseTo(0.2);
    const suspect = (await getContract(
      fakeDb(
        {
          ...baseContractRow,
          signing_value_eur: 5000,
          current_value_eur: 6000,
          value_flag: 'value_suspect',
        },
        [],
      ),
      'c:1',
    ))!;
    expect(suspect.value.deltaPct).toBeNull();
    expect(suspect.value.suspect).toBe(true);
  });

  it('surfaces authority and company totals when the rollup rows exist', async () => {
    const db = fakeD1([
      { when: 'WHERE c.id = ?', first: baseContractRow },
      { when: 'authority_totals', first: { spent_eur: 900000, contracts: 300 } },
      { when: 'company_totals', first: { won_eur: 400000, contracts: 40, primary_sector: '72' } },
      { when: 'cpv_division_stats', first: null },
      { when: 'FROM lots l', all: [] },
      { when: 'FROM amendments', all: [] },
    ]).db;
    const d = (await getContract(db, 'c:1'))!;
    expect(d.authority.totalEur).toBe(900000);
    expect(d.authority.totalContracts).toBe(300);
    expect(d.bidder.totalEur).toBe(400000);
    expect(d.bidder.sector?.code).toBe('72');
  });
});

describe('getContract — lot totals, framework floor, and sector fallbacks', () => {
  it('nulls lot totals and contractor fields when a lot carries no values', async () => {
    const lot = {
      lot_id: 'lot:UNP-1:1',
      title: 'Позиция',
      estimated_value: null,
      estimated_currency: null,
      cpv_code: null,
      contract_id: null,
      signing_value_eur: null,
      estimated_fx_rate: null,
      bidder_name: null,
      bidder_kind: null,
      bidder_id: null,
    };
    const d = (await getContract(fakeDb(baseContractRow, [lot]), 'c:1'))!;
    expect(d.lots!.estimatedTotalEur).toBeNull();
    expect(d.lots!.signedTotalEur).toBeNull();
    expect(d.lots!.rows[0]!.contractorName).toBeNull();
    expect(d.lots!.rows[0]!.contractId).toBeNull();
    expect(d.lots!.rows[0]!.isCurrent).toBe(true);
  });

  it('deduplicates a lot that matches more than one contract row', async () => {
    const mk = (contract_id: string) => ({
      lot_id: 'lot:UNP-1:1',
      title: 'Позиция',
      estimated_value: 1000,
      estimated_currency: 'EUR',
      cpv_code: '45000000',
      contract_id,
      signing_value_eur: 900,
      estimated_fx_rate: null,
      bidder_name: 'Изп ООД',
      bidder_kind: 'company' as const,
      bidder_id: 'eik:1',
    });
    const d = (await getContract(fakeDb(baseContractRow, [mk('c:1'), mk('c:2')]), 'c:1'))!;
    expect(d.lots!.rows).toHaveLength(1); // second duplicate skipped
    expect(d.lots!.estimatedTotalEur).toBe(1000);
  });

  it('flags framework when num_lots is null (lot floor defaults to 1)', async () => {
    const d = (await getContract(
      fakeDb({ ...baseContractRow, tender_awards: 3, num_lots: null }, []),
      'c:1',
    ))!;
    expect(d.frameworkAwards).toBe(3);
  });

  it('nulls the contract sector when there is no CPV code', async () => {
    const d = (await getContract(fakeDb({ ...baseContractRow, cpv_code: null }, []), 'c:1'))!;
    expect(d.sector).toBeNull();
  });
});

describe('getContract — not-found and lot kind default', () => {
  it('returns null when the contract id matches no row', async () => {
    const db = fakeD1([{ when: 'WHERE c.id = ?', first: null }]).db;
    expect(await getContract(db, 'c:missing')).toBeNull();
  });

  it('defaults a lot contractor kind to company when the join leaves it null', async () => {
    const lot = {
      lot_id: 'lot:UNP-1:2',
      title: 'Позиция',
      estimated_value: null,
      estimated_currency: null,
      cpv_code: null,
      contract_id: 'c:9',
      signing_value_eur: null,
      estimated_fx_rate: null,
      bidder_name: 'Изп ООД',
      bidder_kind: null,
      bidder_id: 'eik:9',
    };
    const d = (await getContract(fakeDb(baseContractRow, [lot]), 'c:1'))!;
    expect(d.lots!.rows[0]!.contractorName).toBe('Изп ООД'); // entityName(..., 'company')
  });
});

describe('getContract — the ordering unit on the document vs the authority it belongs to', () => {
  it('surfaces the document’s ordering unit only when it names something other than the authority', async () => {
    // Contracts are signed by a directorate/„второстепенен разпоредител" that rolls up to a parent
    // authority. Showing „Възложител по документа" is only informative when the two actually differ —
    // echoing the authority's own name back at the reader adds a line that says nothing.
    const c = await getContract(
      fakeDb({ ...baseContractRow, source_authority_name: 'ОП „Гробищни паркове“ — Русе' }, []),
      'c:1',
    );
    // cleanName also normalises the Bulgarian quote glyphs on the way out, same as for the authority.
    expect(c!.authority.orderingUnit).toBe('ОП "Гробищни паркове" — Русе');
  });

  it('drops an ordering unit that is the same name folded differently', async () => {
    // foldName, not a raw ===: the two fields come from different feeds, so the same unit routinely
    // arrives with different case, spacing, or quote glyphs. A raw comparison would print the
    // duplicate line on nearly every contract.
    const c = await getContract(
      fakeDb({ ...baseContractRow, source_authority_name: '  authority  ' }, []),
      'c:1',
    );
    expect(c!.authority.orderingUnit).toBeNull();
  });
});
