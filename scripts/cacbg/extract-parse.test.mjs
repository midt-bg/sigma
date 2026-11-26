import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFolder, readRecords } from './extract-parse.mjs';
import { declaration, memoryCorpus } from './extract-fixture.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-extract-parse-'));
process.env.CACBG_RAW = path.join(dir, 'raw');
process.env.CACBG_STAGING = path.join(dir, 'staging');
const { resolveFolder } = await import('./extract.mjs');

const A = 'Иван Тестов Тестов';
const B = 'Мария Тестова Примерна';
const folders = () => ({
  2024: [
    { file: 'a1.xml', name: A },
    { file: 'a2.xml', name: B, body: '<PublicPerson><unclosed' },
  ],
  2025: [
    { file: 'b1.xml', name: A, body: declaration(A, { hash: 'HASH2' }) },
    { file: 'b2.xml', name: B, sourceFolder: '2025y' },
  ],
});
const index = (corpus, folder) => JSON.parse(corpus.objects.get(`${folder}/.index.json`));
const parse = async (corpus, folder, name = folder) => {
  const out = path.join(dir, `${name}.jsonl`);
  const end = await parseFolder(corpus.store, { folder, index: index(corpus, folder), out });
  return { end, bytes: fs.readFileSync(out), out };
};

test('a folder parses into its listing, its documents in index order, its refusals and an end', async () => {
  const corpus = memoryCorpus(folders());
  const { end, out } = await parse(corpus, '2024');
  const records = [];
  for await (const record of readRecords(out)) records.push(record);
  assert.deepEqual(
    records.map((r) => Object.keys(r)[0]),
    ['head', 'list', 'list', 'doc', 'error', 'end'],
  );
  assert.equal(records[0].head.folder, '2024');
  assert.equal(records[3].doc.file, 'a1.xml');
  assert.equal(records[3].doc.d.declarant, A);
  assert.equal(records[4].error.file, 'a2.xml');
  assert.deepEqual(end, { rows: 2, files: 2, documents: 1, errors: 1 });
  assert.deepEqual(records.at(-1).end, end);

  const sibling = await parse(corpus, '2025');
  const doc = sibling.bytes.toString().split('\n').filter(Boolean).map(JSON.parse).at(-2).doc;
  assert.equal(doc.sourceFolder, '2025y', 'a file read from a sibling folder says so');
});

test('the records depend on the folder alone: not the run, the register or another folder', async () => {
  const before = await parse(memoryCorpus(folders()), '2024', 'before');
  const saved = { ...process.env };
  try {
    process.env.SIGMA_RUN_ID = '00000000-0000-4000-8000-000000000001';
    process.env.CACBG_REGISTRY_DB = path.join(dir, 'no-such-register.sqlite');
    const changed = memoryCorpus(folders());
    changed.setFolder('2025', [{ file: 'b9.xml', name: 'Петър Тестов Иванов' }]);
    const after = await parse(changed, '2024', 'after');
    assert.deepEqual(after.bytes, before.bytes);
  } finally {
    process.env = saved;
  }
});

test('reading a folder never reaches the register, the identity rules or the run', () => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const [, spec] of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gms))
      if (spec.startsWith('.')) walk(path.resolve(path.dirname(file), spec));
      else seen.add(spec);
  };
  walk(path.resolve('scripts/cacbg/extract-parse.mjs'));
  const reached = [...seen].map((f) => path.basename(f));
  for (const forbidden of [
    'registry-identity.mjs',
    'source-identity.mjs',
    'progress.mjs',
    'node:sqlite',
    'extract.mjs',
  ])
    assert.ok(!reached.includes(forbidden), `${forbidden} is not part of parsing`);
});

test('records cut short are never decided over', async () => {
  const corpus = memoryCorpus(folders());
  const { out } = await parse(corpus, '2024', 'cut');
  const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
  async function* records() {
    for (const line of lines.slice(0, -1)) yield JSON.parse(line);
  }
  const sink = { write() {} };
  const stats = { decls: 0, dupSkipped: 0, filings: 0, holdings: 0, related: 0, egnHits: 0 };
  Object.assign(stats, { byKind: {} });
  await assert.rejects(
    resolveFolder(records(), {
      seenHash: new Map(),
      stats,
      out: Object.fromEntries(
        [
          'holdingsOut',
          'relatedOut',
          'filingsOut',
          'groupsOut',
          'requestsOut',
          'quarantineOut',
        ].map((k) => [k, sink]),
      ),
    }),
    /Parse records of 2024 are incomplete/,
  );
});

test('a listing that does not match its index, or a changed file, stops the folder', async () => {
  const corpus = memoryCorpus(folders());
  const idx = index(corpus, '2024');
  idx.files.pop();
  await assert.rejects(
    parseFolder(corpus.store, { folder: '2024', index: idx, out: path.join(dir, 'x.jsonl') }),
    /Corpus inventory does not match list: 2024/,
  );
  corpus.objects.set('2024/a1.xml', Buffer.from(declaration(A, { hash: 'OTHER' })));
  await assert.rejects(parse(corpus, '2024', 'y'), /Corpus file missing or changed: 2024\/a1.xml/);
  corpus.objects.set('2024/list.xml', Buffer.from('<root/>'));
  await assert.rejects(parse(corpus, '2024', 'z'), /Corpus list changed: 2024/);
  corpus.objects.delete('2024/list.xml');
  await assert.rejects(parse(corpus, '2024', 'w'), /Missing corpus list: 2024/);
});

test('cleanup', () => fs.rmSync(dir, { recursive: true, force: true }));
