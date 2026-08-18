// node:test — path sanitizers and the refuse-to-run rail for the Trade Register leg.
//
// The deed cache holds third-party personal data (owner/manager names, company addresses), so the
// same rail the CACBG crawl runs behind applies here: everything is written under scratch/, and
// scratch/ must be git-ignored, asserted BEFORE any fetch. ADR-0010 decision 6 as extended by ADR-0033.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { TR_SCRATCH, TR_RAW, TR_DB, safeEik, assertTrScratchIgnored } from './paths.mjs';
import { assertScratchIgnored } from '../cacbg/guard.mjs';

test('the TR scratch tree sits under scratch/ and is git-ignored in this repo', () => {
  assert.ok(TR_SCRATCH.split(path.sep).includes('scratch'), TR_SCRATCH);
  assert.ok(TR_RAW.startsWith(TR_SCRATCH));
  assert.ok(TR_DB.startsWith(TR_SCRATCH));
  assert.doesNotThrow(() => assertTrScratchIgnored());
});

test('the guard is the CACBG one generalized, not a second copy', () => {
  // A duplicated safety rail drifts from the original. assertScratchIgnored now takes the
  // subdirectory, and its existing no-argument callers keep working unchanged.
  assert.doesNotThrow(() => assertScratchIgnored());
  assert.doesNotThrow(() => assertScratchIgnored('tr'));
  // .gitignore ignores `scratch/` WHOLESALE, so every subdirectory of it passes — an unknown name is
  // not a way to reach the failure branch. Escape scratch/ instead (path.join normalises this to
  // `docs/.probe`, which is tracked) to prove the guard still refuses when the target is not ignored.
  assert.throws(() => assertScratchIgnored(path.join('..', 'docs')), /REFUSE TO RUN/);
});

test('safeEik accepts only a bare 9/13-digit code and returns it verbatim', () => {
  assert.equal(safeEik('115536179'), '115536179');
  assert.equal(safeEik('1155361790001'), '1155361790001');
  // Leading zeros survive — public bodies are exactly this shape, and losing them fetches a
  // DIFFERENT company's deed.
  assert.equal(safeEik('000696327'), '000696327');
});

test('safeEik refuses anything that could leave the intended path or URL', () => {
  for (const bad of [
    '',
    null,
    undefined,
    '..',
    '../115536179',
    '/115536179',
    '115536179/../x',
    '115536179?x=1',
    '115536179#f',
    '11553617x',
    '11553617',
    '1155361790',
    'ЕИК 115536179',
    ' 115536179',
    '115536179 ',
  ]) {
    assert.throws(() => safeEik(bad), /unsafe/i, JSON.stringify(bad));
  }
});

test('safeEik does not validate the CHECKSUM — that is a separate question', () => {
  // Path safety and identity validity are different concerns: a shape-valid but checksum-invalid code
  // must still be rejectable by the caller with a specific reason, not conflated into „unsafe path".
  assert.equal(safeEik('115536170'), '115536170');
});
