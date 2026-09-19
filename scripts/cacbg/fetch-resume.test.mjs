// The crawl resumes SET BY SET, not declaration by declaration. A container gets minutes, not hours, so an
// interrupted weekly run has to spend its next attempt on what is still missing — not on re-counting what it
// already has. `<set>/.index.json` is written only where every announced declaration was obtained or recorded
// as a source gap, so it is exactly the receipt a resumed attempt needs; these cases pin what may and may not
// be skipped on the strength of it. Driven through the real run() with an injected getter and a temp corpus,
// like fetch-gate.test.mjs — no network, no TLS, no scratch.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './fetch.mjs';

const BASE = 'https://register.cacbg.bg';
const FOLDER = '2099t'; // passes safeFolder (starts with 20YY); not a real register set

const listXml = (files) =>
  `<root><MainCategory><Category Name="C"><Institution Name="I"><Person><Name>N</Name>` +
  `<Position><Name>P</Name>` +
  files.map((f) => `<Declaration><xmlFile>${f}</xmlFile></Declaration>`).join('') +
  `</Position></Person></Institution></Category></MainCategory></root>`;

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-resume-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Crawl FOLDER with the given declaration list, recording every URL the crawl actually asked for. */
async function crawl(files, extraArgv = []) {
  const asked = [];
  const code = await run({
    httpGet: async (url) => {
      asked.push(url);
      if (url.endsWith('/list.xml'))
        return { status: 200, headers: {}, body: Buffer.from(listXml(files), 'utf8') };
      return { status: 200, headers: {}, body: Buffer.from('<x/>', 'utf8') };
    },
    rawDir: dir,
    guard: () => {},
    argv: ['node', 'fetch.mjs', '--folders', FOLDER, '--concurrency', '1', ...extraArgv],
  });
  return { code, asked };
}

const receipt = () => fs.readFileSync(path.join(dir, FOLDER, '.index.json'), 'utf8');

test('a set already obtained is skipped whole — the second attempt asks only for the list', async () => {
  const first = await crawl(['a1.xml', 'a2.xml']);
  assert.equal(first.code, 0);
  assert.equal(first.asked.length, 3); // list + both declarations
  const sealed = receipt();

  const second = await crawl(['a1.xml', 'a2.xml']);
  assert.equal(second.code, 0);
  assert.deepEqual(second.asked, [`${BASE}/${FOLDER}/list.xml`]);
  // Skipping must not weaken the corpus: the receipt is still the same one, and the set still counts as
  // fully announced-and-obtained, or the completeness gate would have refused with a non-zero code.
  assert.equal(receipt(), sealed);
});

test('a set whose list GREW is crawled again — the receipt is only good for the list it sealed', async () => {
  assert.equal((await crawl(['a1.xml', 'a2.xml'])).code, 0);
  const { code, asked } = await crawl(['a1.xml', 'a2.xml', 'a3.xml']);
  assert.equal(code, 0);
  assert.ok(asked.includes(`${BASE}/${FOLDER}/a3.xml`), 'the added declaration must be fetched');
  assert.ok(!asked.includes(`${BASE}/${FOLDER}/a1.xml`), 'the ones on disk must not be re-fetched');
});

test('a receipt from a truncated crawl does not pass for a complete one', async () => {
  // `--limit` seals a receipt covering one declaration while the set announces two. Trusting it would let a
  // deliberately partial crawl certify the set forever — the corpus would go green missing real files.
  const partial = await crawl(['a1.xml', 'a2.xml'], ['--limit', '1']);
  assert.notEqual(partial.code, 0); // announced 2, attempted 1 → incomplete
  assert.match(receipt(), /a1\.xml/);

  const full = await crawl(['a1.xml', 'a2.xml']);
  assert.equal(full.code, 0);
  assert.ok(full.asked.includes(`${BASE}/${FOLDER}/a2.xml`), 'the unattempted one must be fetched');
});

test('a torn receipt is simply not a receipt', async () => {
  assert.equal((await crawl(['a1.xml', 'a2.xml'])).code, 0);
  fs.writeFileSync(path.join(dir, FOLDER, '.index.json'), '{"listHash":');
  assert.equal((await crawl(['a1.xml', 'a2.xml'])).code, 0);
  // The set is walked again — off the files already on disk, so nothing is re-fetched — and the receipt is
  // rewritten whole, which is how a corpus heals itself instead of needing a hand.
  assert.deepEqual(
    JSON.parse(receipt()).files.map((f) => f.file),
    ['a1.xml', 'a2.xml'],
  );
});
