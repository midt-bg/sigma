// The filter rail's „Към резултатите" link points at #results; every page that shows the rail has to
// carry that target, focusable from the link.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it.each(['contracts', 'companies', 'authorities', 'conflicts'])(
  '/%s marks its result list as the target of the rail’s skip link',
  (route) => {
    const src = readFileSync(resolve(__dirname, `${route}.tsx`), 'utf8');
    expect(src).toContain('<FilterRail');
    expect(src).toContain('<section id="results" tabIndex={-1}>');
  },
);
