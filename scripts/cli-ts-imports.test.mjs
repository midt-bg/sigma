// The plain-Node CLI scripts import shared logic straight out of packages/ as raw TypeScript, which
// Node type-strips on the fly. That resolver is far stricter than the bundler one the vitest suites
// run under: vite happily resolves an extensionless relative specifier, plain Node does not. So an
// import added to a shared module can be green across every package suite and still make
// `node scripts/load-fx.mjs` die at startup with ERR_MODULE_NOT_FOUND — which is exactly what
// happened while writing the drain fix in this branch, and nothing in CI noticed.
//
// This test closes that gap the only way that proves anything: it resolves each specifier the way
// Node's ESM loader does (relative to the importing script) and imports it in a child process with
// no hooks, no register shim and no bundler, asserting the whole graph loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Every `import … from '<relative>'` in a CLI script that reaches outside scripts/ — any extension or
// none, since an extensionless one is precisely the shape that breaks. Only the top-level scripts:
// scripts/cacbg/* run under the register-ts hook and are a different contract.
const IMPORT_RE = /\bfrom\s+'(\.\.\/[^']+)'/g;

function crossPackageImports() {
  const found = [];
  for (const name of readdirSync(here).sort()) {
    if (!name.endsWith('.mjs') || name.endsWith('.test.mjs')) continue;
    const file = resolve(here, name);
    const src = readFileSync(file, 'utf8');
    for (const [, specifier] of src.matchAll(IMPORT_RE)) found.push({ name, file, specifier });
  }
  return found;
}

const imports = crossPackageImports();

test('the scan actually finds the cross-package CLI imports', () => {
  // Without this the whole file degrades to a no-op the moment the regex or the layout drifts —
  // zero pairs would mean zero assertions and a green run. The three known importers today are
  // import.mjs, load-eop.mjs and load-fx.mjs.
  assert.ok(imports.length >= 3, `expected cross-package imports, found ${imports.length}`);
  const importers = new Set(imports.map((i) => i.name));
  for (const expected of ['import.mjs', 'load-eop.mjs', 'load-fx.mjs']) {
    assert.ok(importers.has(expected), `${expected} should import shared package code`);
  }
});

for (const { name, file, specifier } of imports) {
  test(`${name} → ${specifier} loads under plain node`, () => {
    // ESM relative resolution IS new URL(specifier, parent) — no extension search, no index lookup.
    // Doing it here reproduces the loader's answer for the specifier exactly as the script wrote it.
    const target = new URL(specifier, pathToFileURL(file)).href;
    try {
      execFileSync(
        'node',
        ['--input-type=module', '-e', `await import(${JSON.stringify(target)})`],
        {
          encoding: 'utf8',
          stdio: 'pipe',
        },
      );
    } catch (e) {
      assert.fail(
        `${name} cannot load ${specifier} under plain node — the CLI would die at startup:\n${e.stderr}`,
      );
    }
  });
}
