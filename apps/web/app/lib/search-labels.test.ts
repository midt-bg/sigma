import { expect, it } from 'vitest';
import type { SearchHit } from '@sigma/api-contract';
import { kindLabel } from './search-labels';

const hit = (kind: SearchHit['kind'], href: string): SearchHit => ({
  kind,
  href,
  slug: '',
  title: '',
  ident: null,
  subtitle: null,
  amountEur: null,
  amountLabel: '',
});

// The two people groups are split by the evidence we publish, not by what office anyone holds, so a
// declarant is a длъжностно лице in EITHER group. Only someone we know solely from the Trade Register —
// whose route segment is the 64-hex indent the register issues — is a plain лице.
it('calls every declarant an office holder and only registry people plain лица', () => {
  const indent = 'a'.repeat(64);
  expect(kindLabel(hit('official', '/persons/SVBDSDE'))).toBe('длъжностно лице');
  expect(kindLabel(hit('person', '/persons/SVBDSDE'))).toBe('длъжностно лице');
  expect(kindLabel(hit('person', `/persons/${indent}`))).toBe('лице');
  expect(kindLabel(hit('company', '/companies/123'))).toBe('компания');
  expect(kindLabel(hit('authority', '/authorities/1'))).toBe('институция');
  expect(kindLabel(hit('contract', '/contracts/c1'))).toBe('договор');
});
