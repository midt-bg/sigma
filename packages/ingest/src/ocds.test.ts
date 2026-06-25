import { describe, expect, it } from 'vitest';
import {
  classifyBucketKey,
  computeCatchupWindow,
  releaseToAmendments,
  releaseToContracts,
  releaseToLots,
  releaseToParties,
  type OcdsMeta,
  type OcdsRelease,
} from './ocds';
import { refreshSliceStatementGroups, splitSqlStatements } from './refresh';

const meta: OcdsMeta = {
  source: 'ocds:2026:2026-05-01',
  datasetUri: 'ds-uri',
  resourceUri: 'res-uri',
  year: 2026,
  fetchedAt: '2026-05-25T00:00:00Z',
};

const FIXED_NOW = new Date('2026-06-11T12:00:00Z');

function utcDay(addDays = 0): string {
  const d = new Date(FIXED_NOW.getTime());
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + addDays);
  return d.toISOString().slice(0, 10);
}

const release: OcdsRelease = {
  ocid: 'ocds-bg-2026-000123',
  id: 'release-1',
  date: '2026-05-10T09:00:00Z',
  tag: ['contract'],
  parties: [
    {
      id: 'B1',
      name: 'Община Тест',
      identifier: { id: '000000111', scheme: 'BG-EIK' },
      roles: ['buyer'],
    },
    { id: 'S1', name: 'Тест Строй ЕООД', identifier: { id: '200000007' }, roles: ['supplier'] },
  ],
  buyer: { id: 'B1', name: 'Община Тест' },
  tender: {
    title: 'Строеж на път',
    value: { amount: 6_000_000 },
    mainProcurementCategory: 'works',
    procurementMethodDetails: 'Открита процедура',
    items: [{ classification: { id: '45200000', scheme: 'CPV' } }],
  },
  awards: [
    {
      id: 'A1',
      title: 'Award',
      suppliers: [{ id: 'S1', name: 'Тест Строй ЕООД', identifier: { id: '200000007' } }],
    },
  ],
  bids: { statistics: [{ measure: 'bids', value: 3 }] },
  contracts: [
    {
      id: 'DOC-1',
      awardID: 'A1',
      title: 'Договор за строеж',
      dateSigned: '2026-05-12',
      value: { amount: 5_000_000, currency: 'EUR' },
    },
  ],
};

describe('releaseToContracts', () => {
  it('flattens a contract release into a staging row with buyer/supplier/CPV resolved', () => {
    const rows = releaseToContracts(release, meta);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r).toMatchObject({
      source: 'ocds:2026:2026-05-01',
      unp: 'ocds-bg-2026-000123',
      contract_number: 'DOC-1',
      authority_eik: '000000111',
      authority_name: 'Община Тест',
      contractor_eik: '200000007',
      contractor_name: 'Тест Строй ЕООД',
      signing_value: 5_000_000,
      currency: 'EUR',
      estimated_value: 6_000_000,
      cpv_code: '45200000',
      contract_kind: 'Строителство',
      procedure_type: 'Открита процедура',
      bids_received: 3,
      contract_date: '2026-05-12',
      needs_enrichment: 0,
      seq_no: null,
      current_value: null,
    });
  });

  it('coerces malformed, Infinity, and object numeric feed values to null', () => {
    const rows = releaseToContracts(
      {
        ...release,
        tender: { ...release.tender, value: { amount: Infinity } },
        bids: { statistics: [{ measure: 'bids', value: { count: 3 } }] },
        contracts: [
          {
            ...release.contracts![0]!,
            value: { amount: 'not-a-number', currency: 'eur' },
          },
        ],
      },
      meta,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      signing_value: null,
      estimated_value: null,
      bids_received: null,
      currency: 'EUR',
    });
  });

  it('nulls negative numeric values and out-of-range dates/years without throwing', () => {
    const rows = releaseToContracts(
      {
        ...release,
        date: '1989-12-31T00:00:00Z',
        tender: { ...release.tender, value: { amount: -1 } },
        bids: { statistics: [{ measure: 'bids', value: -3 }] },
        contracts: [
          {
            ...release.contracts![0]!,
            dateSigned: '3026-01-01',
            value: { amount: -100, currency: 'EUR' },
          },
        ],
      },
      { ...meta, year: 3026 },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dataset_year: null,
      published_at: null,
      contract_date: null,
      signing_value: null,
      estimated_value: null,
      bids_received: null,
    });
  });

  it('keeps plausible future release and signing dates within the generous sane-date ceiling', () => {
    const datesFor = (relDate: string, dateSigned: string) =>
      releaseToContracts(
        {
          ...release,
          date: relDate,
          contracts: [{ ...release.contracts![0]!, dateSigned }],
        },
        meta,
      )[0]!;

    expect(datesFor('14.05.2024', '2024-05-14')).toMatchObject({
      published_at: '2024-05-14',
      contract_date: '2024-05-14',
    });
    expect(datesFor(utcDay(), utcDay())).toMatchObject({
      published_at: utcDay(),
      contract_date: utcDay(),
    });
    expect(datesFor(utcDay(2), utcDay(2))).toMatchObject({
      published_at: utcDay(2),
      contract_date: utcDay(2),
    });
    expect(datesFor(utcDay(30), utcDay(30))).toMatchObject({
      published_at: utcDay(30),
      contract_date: utcDay(30),
    });
    expect(datesFor('2027-01-15', '2027-01-15')).toMatchObject({
      published_at: '2027-01-15',
      contract_date: '2027-01-15',
    });
    expect(datesFor('2029-05-14', '14.05.2029')).toMatchObject({
      published_at: '2029-05-14',
      contract_date: '2029-05-14',
    });
    expect(datesFor('14.05.2029', '2029-05-14')).toMatchObject({
      published_at: '2029-05-14',
      contract_date: '2029-05-14',
    });
    expect(datesFor('9999-01-01', '2026-02-31')).toMatchObject({
      published_at: null,
      contract_date: null,
    });
  });

  it('handles releases missing parties and release date using package publishedDate', () => {
    const rows = releaseToContracts(
      {
        ocid: 'ocds-bg-2026-000999',
        id: 'release-missing-context',
        tag: ['contract'],
        tender: { title: 'Минимална поръчка', value: { amount: 1000 } },
        contracts: [{ id: 'DOC-MIN', value: { amount: 500, currency: 'bgn' } }],
      },
      { ...meta, publishedDate: '2026-05-20T13:30:00Z' },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      published_at: '2026-05-20',
      authority_eik: null,
      authority_name: null,
      contractor_eik: null,
      contractor_name: null,
      currency: 'BGN',
    });
  });

  it('flattens a multi-contract release into one row per contract', () => {
    const rows = releaseToContracts(
      {
        ...release,
        parties: [
          ...release.parties!,
          {
            id: 'S2',
            name: 'Втори доставчик АД',
            identifier: { id: '300000008' },
            roles: ['supplier'],
          },
        ],
        awards: [
          ...release.awards!,
          {
            id: 'A2',
            title: 'Втора позиция',
            suppliers: [{ id: 'S2', name: 'Втори доставчик АД', identifier: { id: '300000008' } }],
          },
        ],
        contracts: [
          release.contracts![0]!,
          {
            id: 'DOC-2',
            awardID: 'A2',
            dateSigned: '2026-05-13',
            value: { amount: 250_000, currency: 'usd' },
          },
        ],
      },
      meta,
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.contract_number)).toEqual(['DOC-1', 'DOC-2']);
    expect(rows[1]).toMatchObject({
      contract_subject: 'Втора позиция',
      contractor_eik: '300000008',
      contractor_name: 'Втори доставчик АД',
      signing_value: 250_000,
      currency: 'USD',
    });
  });

  it('ignores non-contract releases (e.g. amendments)', () => {
    expect(releaseToContracts({ ...release, tag: ['contractAmendment'] }, meta)).toHaveLength(0);
    expect(releaseToContracts({ ...release, tag: ['tender'], contracts: [] }, meta)).toHaveLength(
      0,
    );
  });
});

describe('releaseToAmendments', () => {
  it('drops amendment rows without a contract number', () => {
    const rows = releaseToAmendments(
      {
        ...release,
        tag: ['contractAmendment'],
        contracts: [
          { ...release.contracts![0]!, id: undefined },
          { ...release.contracts![0]!, id: 'DOC-1' },
        ],
      },
      meta,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.contract_number).toBe('DOC-1');
  });
});

describe('OCDS enrichment mappers', () => {
  it('maps party contacts, award suppliers, and tender lots', () => {
    const enriched: OcdsRelease = {
      ...release,
      parties: [
        {
          id: 'B1',
          name: 'Община Тест',
          identifier: { id: '000000111', scheme: 'BG-EIK' },
          roles: ['buyer'],
          address: {
            streetAddress: 'ул. 1',
            locality: 'София',
            postalCode: '1000',
            region: 'BG411',
            countryName: 'BG',
          },
          contactPoint: { name: 'Иван', email: 'test@example.bg', telephone: '+359 2 000' },
        },
        { id: 'S1', name: 'Тест Строй ЕООД', identifier: { id: '200000007' }, roles: ['supplier'] },
      ],
      tender: {
        ...release.tender,
        id: 'TENDER-1',
        lots: [
          { id: 'LOT-0001', title: 'Позиция 1', value: { amount: '123.45', currency: 'eur' } },
        ],
      },
    };

    expect(releaseToParties(enriched, meta)[0]).toMatchObject({
      eik: '000000111',
      street_address: 'ул. 1',
      locality: 'София',
      region_nuts: 'BG411',
      contact_email: 'test@example.bg',
      contact_phone: '+359 2 000',
    });
    expect(releaseToLots(enriched, meta)[0]).toMatchObject({
      tender_id: 'TENDER-1',
      lot_id: 'LOT-0001',
      title: 'Позиция 1',
      value_amount: 123.45,
      value_currency: 'EUR',
    });
  });
});

describe('bucket key and catchup helpers', () => {
  it('classifies base and OCDS bucket keys', () => {
    expect(classifyBucketKey('daily-договори.json')).toBe('contracts');
    expect(classifyBucketKey('daily-поръчки.json')).toBe('tenders');
    expect(classifyBucketKey('daily-анекси.json')).toBe('annexes');
    expect(classifyBucketKey('обявления-съгласно стандарт OCDS.json')).toBe('ocds');
    expect(classifyBucketKey('README.txt')).toBeNull();
  });

  it('computes a lookback catchup window', () => {
    expect(
      computeCatchupWindow({ maxLoadedDate: '2026-06-01', today: '2026-06-07', lookbackDays: 3 }),
    ).toEqual({ from: '2026-05-29', to: '2026-06-07' });
  });
});

describe('splitSqlStatements', () => {
  it('splits on end-of-line semicolons and strips line comments', () => {
    const sql = '-- a comment\nINSERT INTO t VALUES (1);\nUPDATE t SET x = 2; -- trailing\n';
    expect(splitSqlStatements(sql)).toEqual(['INSERT INTO t VALUES (1)', 'UPDATE t SET x = 2']);
  });
  it('does NOT split on a semicolon inside a string literal', () => {
    const sql = "SELECT * FROM t WHERE name LIKE '%;%';\nDELETE FROM t;\n";
    expect(splitSqlStatements(sql)).toEqual([
      "SELECT * FROM t WHERE name LIKE '%;%'",
      'DELETE FROM t',
    ]);
  });
  it('does NOT strip a line-comment sequence inside a string literal', () => {
    const sql =
      "INSERT INTO t VALUES ('keep -- this text'); -- drop this comment\nDELETE FROM t;\n";
    expect(splitSqlStatements(sql)).toEqual([
      "INSERT INTO t VALUES ('keep -- this text')",
      'DELETE FROM t',
    ]);
  });
  it('splits two statements on one line', () => {
    const sql = 'SELECT 1; SELECT 2;';
    expect(splitSqlStatements(sql)).toEqual(['SELECT 1', 'SELECT 2']);
  });
});

describe('refreshSliceStatementGroups', () => {
  it('groups statements by refresh-batch markers', () => {
    const groups = refreshSliceStatementGroups(`
      CREATE TABLE a (id INTEGER);
      -- @refresh-batch second
      INSERT INTO a VALUES (1);
      INSERT INTO a VALUES (2);
      -- @refresh-batch third
      DELETE FROM a;
    `);

    expect(groups).toEqual([
      { name: 'derive-slice', statements: ['CREATE TABLE a (id INTEGER)'] },
      { name: 'second', statements: ['INSERT INTO a VALUES (1)', 'INSERT INTO a VALUES (2)'] },
      { name: 'third', statements: ['DELETE FROM a'] },
    ]);
  });
});

describe('transient staging SQL helpers', () => {
  it('selects only transient-staging DDL and excludes non-staging tables', async () => {
    const { transientStagingStatements, dropTransientStagingStatements } =
      await import('./refresh');
    const sql = `
      CREATE TABLE raw_contracts (id INTEGER);
      CREATE TABLE some_other_table (id INTEGER);
      CREATE INDEX idx_raw_unp ON raw_contracts(id);
      CREATE INDEX idx_other ON some_other_table(id);
      CREATE TABLE raw_ocds_lots (id INTEGER);
    `;

    expect(transientStagingStatements(sql)).toEqual([
      'CREATE TABLE raw_contracts (id INTEGER)',
      'CREATE INDEX idx_raw_unp ON raw_contracts(id)',
      'CREATE TABLE raw_ocds_lots (id INTEGER)',
    ]);
    expect(dropTransientStagingStatements()).toContain('DROP TABLE IF EXISTS raw_contracts');
    expect(dropTransientStagingStatements()).toContain('DROP TABLE IF EXISTS raw_egov_contracts');
    expect(dropTransientStagingStatements()).not.toContain('DROP TABLE IF EXISTS some_other_table');
  });
});
