import { describe, expect, it } from 'vitest';
import { releaseToContracts, type OcdsMeta, type OcdsRelease } from './ocds';
import { splitSqlStatements } from './refresh';

const meta: OcdsMeta = {
  source: 'ocds:2026:2026-05-01',
  datasetUri: 'ds-uri',
  resourceUri: 'res-uri',
  year: 2026,
  fetchedAt: '2026-05-25T00:00:00Z',
};

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
