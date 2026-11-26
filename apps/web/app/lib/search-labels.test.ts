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

// Beside „Бивш кмет · … · 2018–2019“ the plain word would contradict the line under the name.
it('calls a declarant whose every office is former a former office holder, in either group', () => {
  const former = (kind: SearchHit['kind']) => ({
    ...hit(kind, '/persons/SVBDSDE'),
    formerOfficial: true,
  });
  expect(kindLabel(former('official'))).toBe('бивше длъжностно лице');
  expect(kindLabel(former('person'))).toBe('бивше длъжностно лице');
  // The flag says nothing about a registry person or another kind of hit.
  expect(kindLabel({ ...hit('person', `/persons/${'a'.repeat(64)}`), formerOfficial: true })).toBe(
    'лице',
  );
  expect(kindLabel({ ...hit('company', '/companies/123'), formerOfficial: true })).toBe('компания');
});
