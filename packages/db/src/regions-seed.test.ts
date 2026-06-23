/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BG_REGIONS } from '@sigma/config';

// BG_REGIONS (the /map name -> NUTS3 lookup) and scripts/load-nuts.sql hold two copies of the 28
// region names. If one is renamed without the other, that region silently falls into "unattributed"
// on the map. This pins them together: every BG_REGIONS (nuts3, name) pair must exist in the seed.
const seed = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/load-nuts.sql'),
  'utf8',
);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('BG_REGIONS vs load-nuts.sql seed', () => {
  it('pairs every region nuts3 with the same name as the seed', () => {
    for (const r of BG_REGIONS) {
      expect(seed, `${r.nuts3} should be "${r.name}" in the seed`).toMatch(
        new RegExp(`'${r.nuts3}'\\s*,\\s*'${esc(r.name)}'`),
      );
    }
  });
});
