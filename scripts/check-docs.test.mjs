// Adversarial unit tests for the docs-integrity gate. These exist because the
// gate shipped with three edge-case bugs a happy-path run could not surface
// (PR #182 review): a URL false-positive, a non-.md false-positive, and a
// main-module guard that silently no-oped on encoded paths. Each is pinned here.
//
// Run: node --test scripts/check-docs.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  extractDocsRefs,
  linkTargets,
  isMarkdown,
  isTestFile,
  computeOrphans,
  isMain,
} from './check-docs.mjs';

test('extractDocsRefs finds root-relative docs refs', () => {
  assert.deepEqual(extractDocsRefs('see docs/etl.md and docs/adr/README.md.'), [
    'docs/etl.md',
    'docs/adr/README.md',
  ]);
});

test('extractDocsRefs ignores docs/*.md inside an external URL (finding #2)', () => {
  const text = 'ref https://github.com/other/repo/blob/main/docs/foo.md end';
  assert.deepEqual(extractDocsRefs(text), []);
});

test('extractDocsRefs ignores a non-root path segment', () => {
  assert.deepEqual(extractDocsRefs('packages/x/docs/y.md'), []);
});

test('extractDocsRefs does not false-match .markdown', () => {
  assert.deepEqual(extractDocsRefs('see docs/etl.markdown'), []);
});

test('linkTargets keeps internal links (inline, anchored, titled, reference-style) and skips external URLs', () => {
  const text = [
    '[a](core-scope.md) [b](https://x.dev/y/z.md) [c](adr/README.md#top)',
    '[d](etl.md "ETL doc")',
    '[ref]: v1-implementation-plan.md',
  ].join('\n');
  assert.deepEqual(linkTargets(text).sort(), [
    'adr/README.md',
    'core-scope.md',
    'etl.md',
    'v1-implementation-plan.md',
  ]);
});

test('isMarkdown rejects non-.md files that live under docs/ (finding #1)', () => {
  assert.equal(isMarkdown('docs/spec/contracts.md'), true);
  assert.equal(isMarkdown('docs/spec/schema.json'), false);
  assert.equal(isMarkdown('docs/fixtures/sample.yaml'), false);
});

test('isTestFile matches test/spec files so their fixture paths are not scanned as refs', () => {
  assert.equal(isTestFile('scripts/check-docs.test.mjs'), true);
  assert.equal(isTestFile('apps/web/app/lib/riskLogic.test.ts'), true);
  assert.equal(isTestFile('packages/x/foo.spec.tsx'), true);
  assert.equal(isTestFile('scripts/check-docs.mjs'), false);
  assert.equal(isTestFile('docs/core-scope.md'), false);
});

test('computeOrphans excludes indexed and exempt docs', () => {
  const orphans = computeOrphans(
    ['docs/a.md', 'docs/b.md', 'docs/README.md'],
    new Set(['docs/a.md']),
    new Set(['docs/README.md']),
  );
  assert.deepEqual(orphans, ['docs/b.md']);
});

test('isMain is robust to a checkout path with a space (finding #3)', () => {
  const argv = '/tmp/a b/scripts/check-docs.mjs';
  const url = pathToFileURL(argv).href; // file:///tmp/a%20b/scripts/check-docs.mjs
  assert.equal(isMain(url, argv), true);
  // the old idiom `file://${argv}` would have produced an unencoded, mismatching string
  assert.notEqual(url, `file://${argv}`);
});

test('isMain is false when imported (argv points elsewhere) and safe when argv is undefined', () => {
  assert.equal(isMain('file:///a/check-docs.mjs', '/a/some-test.mjs'), false);
  assert.equal(isMain('file:///a/check-docs.mjs', undefined), false);
});
