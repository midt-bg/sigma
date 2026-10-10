import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { DOCUMENTED_PUBLIC_STAKES } from '@sigma/shared';
import { getPublicStakes, publicStakeEiks } from './public-stakes';

it('reads the public stake from the owners the register records, the Agency list and the documented stakes', async () => {
  const [DOC] = DOCUMENTED_PUBLIC_STAKES;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE registry_roles(eik,role,subject_kind,subject_id,subject_name,share,removed_on,uncertain_after);
      CREATE TABLE public_owned_eik(eik,ownership_kind);
      CREATE TABLE state_owned_eik(eik,ownership_kind,canonical_name);
      CREATE TABLE authorities(id,type_group);
      CREATE TABLE registry_deeds(eik,outcome);
      INSERT INTO authorities VALUES('auth:900000001','община'),('auth:900000002','министерство'),('auth:900000009',NULL);
      INSERT INTO registry_deeds VALUES('900000009','ok');
      INSERT INTO public_owned_eik VALUES('900000003','state');
      INSERT INTO state_owned_eik VALUES('100000006','state','Тест');
      INSERT INTO registry_roles VALUES
        ('100000001','sole_owner','entity','900000002','МИНИСТЕРСТВО НА ТЕСТА',NULL,NULL,NULL),
        ('100000002','sole_owner','entity','900000001','ОБЩИНА ТЕСТОВО',NULL,NULL,NULL),
        ('100000003','sole_owner','entity','900000003','ТЕСТ ХОЛДИНГ ЕАД',NULL,NULL,NULL),
        ('100000004','partner','entity','900000001','ОБЩИНА ТЕСТОВО','2 500',NULL,NULL),
        ('100000004','partner','entity','800000001','ЧАСТНА ТЕСТ ООД','7500',NULL,NULL),
        ('100000005','partner','entity','900000001','ОБЩИНА ТЕСТОВО',NULL,NULL,NULL),
        ('100000005','partner','person','p1','ИВАН ТЕСТОВ','100',NULL,NULL),
        ('100000007','sole_owner','entity','900000008','БЪЛГАРСКА НАРОДНА БАНКА',NULL,NULL,NULL),
        ('100000008','sole_owner','entity','800000002','ЧАСТНА ТЕСТ ООД',NULL,NULL,NULL),
        -- A contracting authority that has a trade partida is a company, not a public body.
        ('100000009','sole_owner','entity','900000009','ТЕСТ ВОДА АД',NULL,NULL,NULL),
        -- An owner whose holding ended is no owner.
        ('100000010','sole_owner','entity','900000002','МИНИСТЕРСТВО НА ТЕСТА',NULL,'2020-01-01',NULL);`);
    const stakes = await getPublicStakes(d1FromSqlite(db), [
      '100000001',
      '100000002',
      '100000003',
      '100000004',
      '100000005',
      '100000006',
      '100000007',
      '100000008',
      '100000009',
      '100000010',
      DOC!.eik,
    ]);
    expect(stakes['100000001']!.direct).toEqual([
      { name: 'МИНИСТЕРСТВО НА ТЕСТА', kind: 'state', pct: 100 },
    ]);
    expect(stakes['100000002']!.direct).toEqual([
      { name: 'ОБЩИНА ТЕСТОВО', kind: 'municipal', pct: 100 },
    ]);
    // Through a public company: indirect, and never a direct stake.
    expect(stakes['100000003']).toMatchObject({
      direct: [],
      indirect: [{ name: 'ТЕСТ ХОЛДИНГ ЕАД', kind: 'state', pct: 100 }],
    });
    // A partner's part of the partners' recorded capital.
    expect(stakes['100000004']!.direct).toEqual([
      { name: 'ОБЩИНА ТЕСТОВО', kind: 'municipal', pct: 25 },
    ]);
    // A partner's share the register does not give: unknown, not 0 and not 100.
    expect(stakes['100000005']!.direct).toEqual([
      { name: 'ОБЩИНА ТЕСТОВО', kind: 'municipal', pct: null },
    ]);
    expect(stakes['100000006']).toEqual({
      listed: 'state',
      derived: null,
      direct: [],
      indirect: [],
    });
    expect(stakes['100000007']!.direct).toEqual([
      { name: 'БЪЛГАРСКА НАРОДНА БАНКА', kind: 'bnb', pct: 100 },
    ]);
    expect(stakes[DOC!.eik]!.direct).toEqual([
      { name: DOC!.owner, kind: DOC!.kind, pct: DOC!.pct },
    ]);
    expect(stakes['100000008']).toBeUndefined();
    expect(stakes['100000009']).toBeUndefined();
    expect(stakes['100000010']).toBeUndefined();
    expect(await getPublicStakes(d1FromSqlite(db), [])).toEqual({});
  } finally {
    db.close();
  }
});

it('tells which companies have a public stake, however small, and none without the ownership tables', async () => {
  const [DOC] = DOCUMENTED_PUBLIC_STAKES;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      `CREATE TABLE registry_roles(eik,role,subject_kind,subject_id,subject_name,share,removed_on,uncertain_after);`,
    );
    // Without the ownership tables nothing is known — not even that a company is private.
    expect([...(await publicStakeEiks(d1FromSqlite(db), ['100000004']))]).toEqual([]);
    db.exec(`CREATE TABLE public_owned_eik(eik,ownership_kind);
      CREATE TABLE state_owned_eik(eik,ownership_kind,canonical_name);
      CREATE TABLE authorities(id,type_group);
      CREATE TABLE registry_deeds(eik,outcome);
      INSERT INTO authorities VALUES('auth:900000005','министерство');
      INSERT INTO public_owned_eik VALUES('900000003','state'),('100000006','municipal');
      INSERT INTO registry_roles VALUES
        ('100000001','partner','entity','900000001','Община Тестово','10',NULL,NULL),
        ('100000001','partner','entity','800000001','ЧАСТНА ТЕСТ ООД','90',NULL,NULL),
        ('100000002','partner','entity','900000003','ТЕСТ ХОЛДИНГ ЕАД','5',NULL,NULL),
        ('100000003','sole_owner','entity','900000005','АГЕНЦИЯ ТЕСТ',NULL,NULL,NULL),
        ('100000004','sole_owner','entity','800000001','ЧАСТНА ТЕСТ ООД',NULL,NULL,NULL),
        ('100000005','partner','entity','900000001','ОБЩИНА ТЕСТОВО','10','2019-01-01',NULL);`);
    const found = await publicStakeEiks(d1FromSqlite(db), [
      '100000001',
      '100000002',
      '100000003',
      '100000004',
      '100000005',
      '100000006',
      DOC!.eik,
    ]);
    expect([...found].sort()).toEqual(
      ['100000001', '100000002', '100000003', '100000006', DOC!.eik].sort(),
    );
    expect([...(await publicStakeEiks(d1FromSqlite(db), []))]).toEqual([]);
  } finally {
    db.close();
  }
});
