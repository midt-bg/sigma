// node:test — the day-job correction of ADR-0040: a filing whose own „Месторабота" is a private company is
// re-homed to the institution the same declarant filed under within a year, and only then. Every case
// here is one the site got wrong or one it must not get wrong in the other direction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOffices } from './declaration-office.mjs';

const GUID = 'BE34B4EA-A0C0-4958-B891-B09BFA1B1B2A';
const OTHER = 'C0FFEE00-0000-4000-8000-000000000001';
const file = (guid, n) => `${guid}${n}.xml`;
const rec = (guid, n, year, institution) => ({
  folder: String(year),
  xmlFile: file(guid, n),
  year: String(year),
  institution,
});

const PRIVATE = new Set(['ТЕСТ ГРУП ХОЛДИНГ АД', 'ЧАСТНО ООД']);
const by = {
  institutionOf: (r) => r.institution,
  sourceId: (r) => `cacbg:${r.folder}:${r.xmlFile}`,
  guidOf: (xmlFile) => /^([0-9A-F-]{36})\d+\.xml$/i.exec(xmlFile)?.[1] ?? null,
  isPrivateCompany: (name) => PRIVATE.has(name),
};

test('the annual filed under the day job takes the office the entry named, in the same year', () => {
  const filings = [
    rec(GUID, 170080, 2024, 'ТЕСТ ПОЩИ ЕАД'), // the entry declaration, listed under the enterprise
    rec(GUID, 213894, 2024, 'ТЕСТ ГРУП ХОЛДИНГ АД'), // the annual for 2024: „Месторабота" is the day job
    rec(GUID, 222200, 2025, 'ТЕСТ ПОЩИ ЕАД'),
  ];
  const offices = resolveOffices(filings, by);
  assert.deepEqual([...offices], [['cacbg:2024:' + file(GUID, 213894), 'ТЕСТ ПОЩИ ЕАД']]);
});

test('the neighbouring year lends when the same year has nothing, the nearer one first', () => {
  const filings = [
    rec(GUID, 1, 2022, 'СТАРО ВЕДОМСТВО'),
    rec(GUID, 2, 2023, 'ТЕСТ ГРУП ХОЛДИНГ АД'),
    rec(GUID, 3, 2024, 'НОВО ВЕДОМСТВО'),
  ];
  // Both neighbours are one year away; the earlier one is the office the year began with.
  assert.equal(resolveOffices(filings, by).get('cacbg:2023:' + file(GUID, 2)), 'СТАРО ВЕДОМСТВО');
  filings[0].year = '2021';
  assert.equal(resolveOffices(filings, by).get('cacbg:2023:' + file(GUID, 2)), 'НОВО ВЕДОМСТВО');
});

test('a filing two years from any office, another declarant’s office, or no GUID is left alone', () => {
  const filings = [
    rec(GUID, 1, 2020, 'ВЕДОМСТВО'),
    rec(GUID, 2, 2023, 'ТЕСТ ГРУП ХОЛДИНГ АД'), // three years away
    rec(OTHER, 3, 2023, 'ЧУЖДО ВЕДОМСТВО'), // same year, somebody else
    { folder: '2019', xmlFile: 'legacy.xml', year: '2019', institution: 'ЧАСТНО ООД' }, // no GUID
  ];
  assert.equal(resolveOffices(filings, by).size, 0);
});

test('a public body never lends to itself, and a private company never lends', () => {
  const filings = [
    rec(GUID, 1, 2024, 'ТЕСТ ГРУП ХОЛДИНГ АД'),
    rec(GUID, 2, 2024, 'ЧАСТНО ООД'), // two private day jobs: neither is an office
    rec(GUID, 3, 2024, 'ВЕДОМСТВО'),
  ];
  const offices = resolveOffices(filings, by);
  assert.equal(offices.get('cacbg:2024:' + file(GUID, 1)), 'ВЕДОМСТВО');
  assert.equal(offices.get('cacbg:2024:' + file(GUID, 2)), 'ВЕДОМСТВО');
  assert.equal(offices.has('cacbg:2024:' + file(GUID, 3)), false);
});
