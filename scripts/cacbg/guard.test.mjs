import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeXmlFile, safeYear, safeFolder, assertScratchIgnored } from './guard.mjs';

// The path-sanitizers are the ONLY gate between an untrusted register index (list.xml, folder ids) and a
// filesystem path / URL (fetch.mjs, extract.mjs). A regression here is a path-traversal vulnerability, so
// these are the adversarial cases the security rule (path-traversal) demands.

test('safeXmlFile: clean *.xml passes; hostile input is rejected OR reduced to a separator-free basename', () => {
  assert.equal(safeXmlFile('list.xml'), 'list.xml');
  assert.equal(safeXmlFile('A-1_2.xml'), 'A-1_2.xml');

  // Forward-slash / absolute POSIX traversal MUST neutralise to the bare basename (the documented behaviour
  // on the supported platform) — the value reaching the filesystem can never escape the intended dir.
  assert.equal(safeXmlFile('../../../etc/passwd.xml'), 'passwd.xml');
  assert.equal(safeXmlFile('/abs/evil.xml'), 'evil.xml');
  assert.equal(safeXmlFile('a/b/c.xml'), 'c.xml');

  // Security INVARIANT for ANY input: safeXmlFile must never RETURN a value containing a path separator
  // (that is what would enable traversal). It may satisfy this by neutralising OR by throwing — both safe.
  // On POSIX a backslash is not a separator, so `\`-delimited names are rejected by the charset regex (a
  // throw) rather than neutralised — still safe. The loop accepts either outcome, so it holds cross-platform.
  for (const h of ['..\\..\\x.xml', 'C:\\evil.xml', '../../x.xml', '/a/b.xml', 'sub/dir/f.xml']) {
    let out;
    try {
      out = safeXmlFile(h);
    } catch {
      continue; // rejected — safe
    }
    assert.doesNotMatch(out, /[\\/]/, `${h} → ${out} must not contain a path separator`);
    assert.match(out, /^[A-Za-z0-9._-]+\.xml$/);
  }

  // Wrong extension / no extension / illegal chars (spaces, ';') → hard throw, never a silent pass.
  for (const bad of ['evil.txt', 'noext', 'x.xml.exe', 'a b.xml', 'x;.xml', '.xml', '']) {
    assert.throws(() => safeXmlFile(bad), /unsafe xmlFile/, `${bad} must be rejected`);
  }
});

test('safeYear accepts only a 4-digit 20xx year', () => {
  assert.equal(safeYear('2024'), '2024');
  assert.equal(safeYear(2021), '2021'); // number coerces to the string form
  for (const bad of ['1999', '20240', '204', '2024x', '../2024', '2024;DROP', '', '20 4']) {
    assert.throws(() => safeYear(bad), /unsafe year/, `${bad} must be rejected`);
  }
});

test('safeFolder accepts a year-prefixed short alnum/_ id and rejects injection', () => {
  for (const ok of ['2024', '2021_nc', '2019e', '2024f1', '2025y', '2018h']) {
    assert.equal(safeFolder(ok), ok);
  }
  for (const bad of [
    '1999', // not a 20xx year
    'x2024', // must START with the year
    '2024/../x', // separator → traversal
    '2024\\x',
    '2024;rm', // ';' not allowed
    '2024_verylongsuffix', // suffix > 8 chars
    '2024 ', // trailing space
    '',
  ]) {
    assert.throws(() => safeFolder(bad), /unsafe folder/, `${bad} must be rejected`);
  }
});

test('assertScratchIgnored passes in this repo (scratch/ is git-ignored — the PII rail)', () => {
  // The refuse-to-run guard: scratch/ MUST be git-ignored so scraped PII can never land in a commit.
  assert.doesNotThrow(() => assertScratchIgnored());
});
