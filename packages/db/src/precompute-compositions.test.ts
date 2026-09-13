import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { getParticipantContracts } from './queries/details';

it('counts resolved member sets once, preserves incomplete groups and every source contract', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE bidders(id,name,kind);
      CREATE TABLE company_totals(bidder_id,won_eur);
      CREATE TABLE consortium_members(consortium_id,bidder_id);
      CREATE TABLE company_links(a_bidder_id,b_bidder_id,kind,directed,weight_eur,occurrences);
      CREATE TABLE contracts(id,bidder_id,tender_id,contract_subject,signed_at,amount_eur);
      CREATE TABLE tenders(id,title,authority_id);
      CREATE TABLE authorities(id,name);
      INSERT INTO bidders VALUES('a','A','company'),('b','B','company'),('ab','A; B','consortium'),('ba','B; A','consortium'),('abc','A; B; unresolved C','consortium'),('abd','A; B; unresolved D','consortium');
      INSERT INTO company_totals VALUES('ab',100),('ba',200),('abc',300),('abd',400);
      INSERT INTO consortium_members VALUES('ab','a'),('ab','b'),('ba','a'),('ba','b'),('abc','a'),('abc','b'),('abd','a'),('abd','b');
      INSERT INTO authorities VALUES('auth:1','Възложител');
      INSERT INTO tenders VALUES('t','Subject','auth:1');
      INSERT INTO contracts VALUES('c1','ab','t','One','2023-01-01',100),('c2','ba','t','Two','2024-01-01',200),('c3','abc','t','Three','2025-01-01',300),('c4','abd','t','Four',NULL,400);`);
    const precompute = readFileSync(
      new URL('../../../scripts/precompute.sql', import.meta.url),
      'utf8',
    );
    const start = precompute.indexOf('INSERT INTO company_links');
    db.exec(precompute.slice(start, precompute.indexOf('-- (b)', start)));
    expect(db.prepare('SELECT weight_eur,occurrences FROM company_links').get()).toMatchObject({
      weight_eur: 1000,
      occurrences: 3,
    });
    const contracts = await getParticipantContracts(d1FromSqlite(db), 'a');
    expect(contracts).toHaveLength(4);
    expect(new Set(contracts.map((c) => c.id)).size).toBe(4);
    expect(contracts.reduce((sum, c) => sum + (c.valueEur ?? 0), 0)).toBe(1000);
    expect(contracts.find((c) => c.id === 'c2')?.groupName).toBe('B; A');
  } finally {
    db.close();
  }
});
