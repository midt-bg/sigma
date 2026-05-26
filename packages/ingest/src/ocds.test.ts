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
});
