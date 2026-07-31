// node:test — institution canonicalization (N10, review #226). The person grain is (name, institution);
// an official who writes „МВР" in one filing and „Министерство на вътрешните работи" in another must fold to
// ONE identity, not split into two person-pages. The map is CONSERVATIVE by design: only unambiguous,
// stable central-government abbreviations fold. An unknown/ambiguous abbreviation falls through unchanged —
// a SPLIT (safe: two pages for one person) is preferred over a wrong MERGE (libel: two people as one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalInstitution } from './institutions.mjs';

test('canonicalInstitution — folds an unambiguous ministry abbreviation to its full name', () => {
  const full = 'Министерство на вътрешните работи';
  assert.equal(canonicalInstitution('МВР'), full);
  assert.equal(canonicalInstitution('  мвр '), full); // case / whitespace insensitive
  assert.equal(canonicalInstitution('МВнР'), 'Министерство на външните работи');
  // the full name is already canonical → returned as itself (idempotent)
  assert.equal(canonicalInstitution(full), full);
  assert.equal(canonicalInstitution(canonicalInstitution('МВР')), full);
});

test('canonicalInstitution — leaves unknown / ambiguous institutions unchanged (prefer split over wrong merge)', () => {
  // МТ is ambiguous (транспорт vs туризъм over the years) → intentionally NOT in the map
  assert.equal(canonicalInstitution('МТ'), 'МТ');
  assert.equal(canonicalInstitution('Община Русе'), 'Община Русе');
  assert.equal(
    canonicalInstitution('Някаква непозната институция'),
    'Някаква непозната институция',
  );
});

test('canonicalInstitution — empty / nullish is empty (never a spurious canonical value)', () => {
  assert.equal(canonicalInstitution(''), '');
  assert.equal(canonicalInstitution('   '), '');
  assert.equal(canonicalInstitution(null), '');
  assert.equal(canonicalInstitution(undefined), '');
});
