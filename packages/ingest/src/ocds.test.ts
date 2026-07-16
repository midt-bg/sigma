import { describe, expect, it } from 'vitest';
import {
  classifyBucketKey,
  computeCatchupWindow,
  daysInWindow,
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

describe('date normalization fallbacks (via releaseToContracts.contract_date)', () => {
  const rel = (dateSigned: string): OcdsRelease => ({
    tag: ['contract'],
    ocid: 'ocds-x',
    contracts: [{ id: 'c1', dateSigned }],
  });
  it('parses a Date.parseable non-ISO, non-DMY dateSigned via the UTC fallback', () => {
    expect(releaseToContracts(rel('01 Jan 2020 00:00:00 GMT'), meta)[0]?.contract_date).toBe(
      '2020-01-01',
    );
  });
  it('nulls an unparseable dateSigned rather than throwing', () => {
    expect(releaseToContracts(rel('изобщо не е дата'), meta)[0]?.contract_date).toBeNull();
  });
  it('nulls a date below the 1990 data floor', () => {
    expect(releaseToContracts(rel('1985-06-01'), meta)[0]?.contract_date).toBeNull();
  });
});

describe('releaseToAmendments — early exits', () => {
  it('returns [] for a release without a contractAmendment/contractUpdate tag', () => {
    expect(releaseToAmendments({ tag: ['contract'], contracts: [{ id: 'c1' }] }, meta)).toEqual([]);
  });
  it('returns [] for an amendment-tagged release that carries no contracts', () => {
    expect(releaseToAmendments({ tag: ['contractAmendment'], contracts: [] }, meta)).toEqual([]);
  });
});

describe('computeCatchupWindow / daysInWindow — day validation', () => {
  it('rejects a today that is not strictly YYYY-MM-DD', () => {
    expect(() =>
      computeCatchupWindow({ maxLoadedDate: null, today: '2026-6-1', lookbackDays: 7 }),
    ).toThrow(/YYYY-MM-DD/);
  });
  it('rejects a well-formatted but impossible calendar date', () => {
    expect(() => daysInWindow('2026-02-30', '2026-03-01')).toThrow(/not a valid date/);
  });
  it('counts an inclusive day window', () => {
    expect(daysInWindow('2026-05-01', '2026-05-01')).toBe(1);
    expect(daysInWindow('2026-05-01', '2026-05-10')).toBe(10);
  });
  it('throws when from is after to', () => {
    expect(() => daysInWindow('2026-05-10', '2026-05-01')).toThrow(/before or equal/);
  });
});

describe('branch completion — parties, lots, catch-up window', () => {
  it('releaseToParties nulls every optional field and joins roles, blanking an empty role set', () => {
    const rows = releaseToParties(
      {
        ocid: 'ocds-x',
        parties: [
          {
            id: 'P1',
            name: 'Ф ООД',
            identifier: { id: '111', scheme: 'BG-EIK' },
            roles: ['buyer', 'supplier'],
            address: { region: 'BG411' },
            contactPoint: { email: 'a@b.bg' },
          },
          { id: 'P2' }, // no identifier, roles, address, or contactPoint → all nulls
        ],
      },
      meta,
    );
    expect(rows[0]).toMatchObject({
      eik: '111',
      roles: 'buyer,supplier',
      region_nuts: 'BG411',
      contact_email: 'a@b.bg',
    });
    expect(rows[1]).toMatchObject({
      eik: null,
      scheme: null,
      roles: null, // empty roles → '' → null
      region_nuts: null,
      contact_email: null,
      contact_name: null,
    });
  });

  it('releaseToLots coerces lot value/currency and nulls missing pieces', () => {
    const rows = releaseToLots(
      {
        ocid: 'ocds-x',
        tender: {
          id: 'T1',
          lots: [
            { id: 'L1', title: 'Позиция 1', value: { amount: 1000, currency: 'eur' } },
            { value: { amount: 'nope', currency: 'zz' } }, // bad amount/currency, no id/title
          ],
        },
      },
      meta,
    );
    expect(rows[0]).toMatchObject({
      lot_id: 'L1',
      title: 'Позиция 1',
      value_amount: 1000,
      value_currency: 'EUR',
    });
    expect(rows[1]).toMatchObject({
      lot_id: null,
      title: null,
      value_amount: null,
      value_currency: null,
    });
  });

  it('computeCatchupWindow subtracts from maxLoadedDate and clamps a future from to today', () => {
    // maxLoadedDate present → window measured back from it.
    expect(
      computeCatchupWindow({ maxLoadedDate: '2026-05-20', today: '2026-05-25', lookbackDays: 5 }),
    ).toEqual({
      from: '2026-05-15',
      to: '2026-05-25',
    });
    // maxLoadedDate ahead of today with zero lookback → from would exceed today → clamped to today.
    expect(
      computeCatchupWindow({ maxLoadedDate: '2026-05-20', today: '2026-05-01', lookbackDays: 0 }),
    ).toEqual({
      from: '2026-05-01',
      to: '2026-05-01',
    });
    // no maxLoadedDate → window measured back from today.
    expect(
      computeCatchupWindow({ maxLoadedDate: null, today: '2026-05-10', lookbackDays: 3 }),
    ).toEqual({
      from: '2026-05-07',
      to: '2026-05-10',
    });
  });
});

describe('branch completion — amendments, empty/full party + lot shapes', () => {
  it('releaseToAmendments reads the last amendment and nulls when none/idless', () => {
    const rows = releaseToAmendments(
      {
        tag: ['contractUpdate'],
        ocid: 'x',
        contracts: [
          {
            id: 'c1',
            amendments: [{ description: 'първо' }, { description: 'финал', rationale: 'причина' }],
          },
          { id: 'c2' }, // no amendments → amd null → description/reason null
          { title: 'no id' }, // idless → skipped
        ],
      },
      meta,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      contract_number: 'c1',
      description: 'финал',
      reason: 'причина',
    });
    expect(rows[1]).toMatchObject({ contract_number: 'c2', description: null, reason: null });
  });

  it('releaseToParties returns [] for a release with no parties', () => {
    expect(releaseToParties({ ocid: 'x' }, meta)).toEqual([]);
  });

  it('releaseToParties passes a fully-populated address and contact point through', () => {
    const [row] = releaseToParties(
      {
        parties: [
          {
            id: 'P1',
            name: 'Ф',
            identifier: { id: '1', scheme: 'BG-EIK' },
            address: {
              streetAddress: 'ул. Тест 1',
              locality: 'София',
              postalCode: '1000',
              region: 'BG411',
              countryName: 'България',
            },
            contactPoint: { name: 'Иван', email: 'i@b.bg', telephone: '+359' },
          },
        ],
      },
      meta,
    );
    expect(row).toMatchObject({
      ocid: null, // release had no ocid → null branch
      street_address: 'ул. Тест 1',
      locality: 'София',
      postal_code: '1000',
      country: 'България',
      contact_name: 'Иван',
      contact_phone: '+359',
    });
  });

  it('releaseToParties nulls ocid and party_id when both are absent', () => {
    const [row] = releaseToParties({ parties: [{ name: 'безименна' }] }, meta);
    expect(row).toMatchObject({ ocid: null, party_id: null, name: 'безименна' });
  });

  it('releaseToLots returns [] when the release carries no tender', () => {
    expect(releaseToLots({ ocid: 'x' }, meta)).toEqual([]);
    expect(releaseToLots({ ocid: 'x', tender: {} }, meta)).toEqual([]);
  });
});

describe('branch completion — amendment id/date/ocid and value-less lot', () => {
  it('releaseToAmendments fills document_number, contract_date and unp from present fields', () => {
    const [row] = releaseToAmendments(
      {
        id: 'NOTICE-9',
        tag: ['contractAmendment'],
        // no ocid → unp null branch
        parties: [{ id: 'B', name: 'Общ', identifier: { id: '77' }, roles: ['buyer'] }],
        buyer: { id: 'B', name: 'Общ' },
        contracts: [{ id: 'c1', dateSigned: '2026-04-02', amendments: [{ rationale: 'r' }] }],
      },
      meta,
    );
    expect(row).toMatchObject({
      document_number: 'NOTICE-9',
      contract_date: '2026-04-02',
      unp: null,
      authority_eik: '77',
      description: null, // amendment had no description
      reason: 'r',
    });
  });

  it('releaseToLots nulls value fields for a lot with no value object', () => {
    const [row] = releaseToLots({ ocid: 'x', tender: { id: 'T', lots: [{ id: 'L' }] } }, meta);
    expect(row).toMatchObject({ lot_id: 'L', value_amount: null, value_currency: null });
  });
});
