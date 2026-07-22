import { describe, expect, it } from 'vitest';
import { getContract } from './details';

const baseContractRow = {
  id: 'c:1',
  tender_id: 't:UNP-1',
  contract_subject: 'Contract subject',
  contract_number: null as string | null,
  document_number: null,
  lot_id: 'lot:UNP-1:1',
  signed_at: '2024-01-15',
  published_at: '2024-01-16',
  contract_kind: 'services',
  eu_funded: 0,
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
  subcontractor_eik: null,
  subcontractor_name: null,
  subcontract_value: null,
  contract_currency: 'EUR',
  title: 'Tender subject',
  unp: 'UNP-1',
  procedure_type: 'Открита процедура',
  cpv_code: '72000000',
  cpv_description: 'IT services',
  num_lots: 2,
  estimated_value: 10000,
  tender_currency: 'EUR',
  tender_fx_rate: null as number | null,
  start_date: null,
  end_date: null,
  authority_id: 'auth:123456789',
  authority_name: 'Authority',
  authority_type_group: 'ministry',
  authority_settlement: 'Sofia',
  bidder_id: 'eik:111111111',
  bidder_name: 'Bidder',
  bidder_kind: 'company' as const,
  bidder_eik: '111111111',
  bidder_settlement: 'Sofia',
};

function fakeDb(
  contractRow: typeof baseContractRow,
  lotRows: unknown[],
  amendmentRows: unknown[] = [],
): D1Database {
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          binds = values;
          return statement;
        },
        async first<T>() {
          if (sql.includes('WHERE c.id = ?')) return contractRow as T;
          if (sql.includes('authority_totals') || sql.includes('company_totals')) return null as T;
          throw new Error(`unexpected first query: ${sql}`);
        },
        async all<T>() {
          if (sql.includes('FROM lots l')) {
            expect(binds).toEqual([contractRow.tender_currency, contractRow.tender_id]);
            return { results: lotRows as T[] };
          }
          if (sql.includes('FROM amendments')) {
            expect(binds).toEqual([contractRow.unp, contractRow.contract_number]);
            return { results: amendmentRows as T[] };
          }
          throw new Error(`unexpected all query: ${sql}`);
        },
      };
      return statement;
    },
  } as D1Database;
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
          bidder_id: 'eik:111111111',
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
          bidder_id: 'eik:111111111',
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
    }
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
