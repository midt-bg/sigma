import { describe, expect, it } from 'vitest';
import { eopProcedureUrl, sourceLinks } from './source-link';

describe('eopProcedureUrl', () => {
  it('builds the ЦАИС ЕОП procedure link from a safe tender id', () => {
    expect(eopProcedureUrl('00012345')).toBe('https://app.eop.bg/today/00012345');
  });
  it('returns null for absent or unsafe ids (no path/protocol smuggling)', () => {
    expect(eopProcedureUrl(null)).toBeNull();
    expect(eopProcedureUrl('')).toBeNull();
    expect(eopProcedureUrl('../../evil')).toBeNull();
    expect(eopProcedureUrl('1 2; rm')).toBeNull();
    expect(eopProcedureUrl('https://elsewhere.example/x')).toBeNull();
  });
});

describe('sourceLinks', () => {
  it('includes the procedure link plus the day open-data files when both inputs are present', () => {
    const links = sourceLinks({ eopTenderId: 'T-1', publishedAt: '2023-05-01' });
    expect(links[0]).toEqual({
      label: 'Процедура в ЦАИС ЕОП',
      url: 'https://app.eop.bg/today/T-1',
    });
    // three grounded base open-data files for a pre-2026 day
    expect(links.filter((l) => l.url.startsWith('https://storage.eop.bg/'))).toHaveLength(3);
  });

  it('omits links it cannot ground instead of fabricating them', () => {
    expect(sourceLinks({})).toEqual([]); // no tender id, no date → no links, not a guess
    const onlyProc = sourceLinks({ eopTenderId: 'T-9' });
    expect(onlyProc).toHaveLength(1);
  });
});
