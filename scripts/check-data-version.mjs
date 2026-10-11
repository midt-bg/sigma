#!/usr/bin/env node
// A pull request that changes how stored values are computed should say whether the rows already stored
// still hold (docs/deploy.md, „Версията на данните“). This warns — never fails — when one of the files that
// compute them changes while packages/db/data-version.json keeps its version: the reviewer decides whether
// the change needs a rebuilt slot (raise the version) or applies to new rows only.
//
//   node scripts/check-data-version.mjs <base ref>
//
// The pull request's merge commit holds the base plus the change, so a two-dot diff against the base is the
// change itself and needs no merge base — a shallow checkout is enough.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FILE = 'packages/db/data-version.json';

/** The warnings for a change: `changed` file names, the data-version file before and after. Pure. */
export function dataVersionWarnings({ changed, before, after }) {
  if (!before) return []; // the file is new: nothing to compare with
  if (after.version !== before.version) return [];
  const touched = changed.filter((f) => after.computedBy.includes(f));
  return touched.length
    ? [
        `${touched.join(', ')} compute stored values, and ${FILE} still says version ${after.version}. ` +
          'If rows already stored would now be computed differently, raise the version: the release is ' +
          'then a rebuilt slot and a switch, not an in-place deploy.',
      ]
    : [];
}

function main() {
  const base = process.argv[2];
  if (!base) throw new Error('usage: check-data-version.mjs <base ref>');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
  const changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
  let before = null;
  try {
    before = JSON.parse(git('show', `${base}:${FILE}`));
  } catch {
    before = null;
  }
  const after = JSON.parse(readFileSync(FILE, 'utf8'));
  for (const w of dataVersionWarnings({ changed, before, after }))
    console.log(`::warning title=Data version::${w}`);
}

if (import.meta.main) main();
