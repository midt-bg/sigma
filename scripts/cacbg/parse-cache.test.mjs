import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { STREAMS } from './extract-checkpoint.mjs';
import { declaration, memoryCorpus } from './extract-fixture.mjs';
import {
  entryKey,
  inputsKey,
  parserClosure,
  parserVersion,
  restoreEntry,
  saveEntry,
} from './parse-cache.mjs';
import { folderFiles } from './extract-parse.mjs';

// One staging dir for the file: extract.mjs reads its paths when the module loads.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-parse-cache-'));
const staging = path.join(dir, 'staging');
process.env.CACBG_RAW = path.join(dir, 'raw');
process.env.CACBG_STAGING = staging;
delete process.env.CACBG_REGISTRY_DB;
delete process.env.SIGMA_RUN_ID;
delete process.env.CACBG_PARSE_CACHE;
const { run } = await import('./extract.mjs');

// Invented people. A name variant (one slip), a declaration listed under another name (quarantined, or a
// registry alias once the register proves it), a document republished in a later folder (a duplicate and
// a source group), a malformed file, and a file kept in a sibling folder.
const IVAN = 'Иван Тестов Тестов';
const MARIA = 'Мария Тестова Примерна';
const PETAR = 'Петър Тестов Иванов';
const republished = declaration(MARIA, { hash: 'SAME' });
const corpusFolders = () => ({
  2022: [{ file: 'z1.xml', name: PETAR, body: declaration(PETAR, { hash: 'Z1' }) }],
  2023: [
    { file: 'a1.xml', name: IVAN, body: declaration(IVAN, { company: '„ТЕСТ ГРУП“ ЕООД' }) },
    { file: 'a2.xml', name: MARIA, body: republished },
    { file: 'a3.xml', name: MARIA, body: '<PublicPerson><unclosed' },
  ],
  2024: [
    { file: 'b1.xml', name: 'Иван Тестов Тестав', body: declaration(IVAN, { hash: 'B1' }) },
    { file: 'b2.xml', name: MARIA, body: republished },
    { file: 'b3.xml', name: PETAR, body: declaration(PETAR, { hash: 'B3' }), person: 1 },
    { file: 'b4.xml', name: PETAR, body: declaration(PETAR, { hash: 'B4' }), person: 1 },
  ],
  '2024y': [{ file: 'c1.xml', name: PETAR, body: declaration(PETAR, { hash: 'C1' }) }],
  2025: [
    {
      file: 'd1.xml',
      name: 'Иван Тестов Иванов',
      body: declaration(IVAN, { hash: 'D1', company: '„ТЕСТ ГРУП“ ЕООД' }),
    },
    {
      file: 'd2.xml',
      name: MARIA,
      body: declaration(MARIA, { hash: 'D2' }),
      sourceFolder: '2025y',
    },
  ],
});

/** One extract over `store`: its six files, its counters as printed, its cache report, its reads. */
async function extract(corpus, env = {}) {
  const logs = [];
  const { log, warn } = console;
  console.log = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => logs.push(args.join(' '));
  const saved = { ...process.env };
  Object.assign(process.env, env);
  corpus.reads.length = 0;
  let code;
  try {
    code = await run({ store: corpus.store });
  } finally {
    process.env = saved;
    console.log = log;
    console.warn = warn;
  }
  const { extractedAt, ...manifest } = JSON.parse(
    fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8'),
  );
  assert.ok(extractedAt);
  const line = (event) => logs.find((l) => l.startsWith(`{"event":"${event}"`));
  return {
    code,
    outputs: Object.fromEntries(
      STREAMS.map((s) => [s, fs.readFileSync(path.join(staging, `${s}.jsonl`), 'utf8')]),
    ),
    manifest,
    // The counters exactly as the run prints them: field order included.
    summary: logs[logs.indexOf('\n=== extract summary ===') + 1],
    quarantine: line('declarations_quarantine'),
    cache: JSON.parse(line('declarations_parse_cache')),
    unusable: logs.filter((l) => l.startsWith('{"event":"declarations_parse_cache_unusable"')),
    xmlReads: corpus.reads.filter((k) => /^20[^/]+\/[^/]+\.xml$/.test(k)),
    logs,
  };
}
const entries = (corpus) =>
  new Map([...corpus.objects].filter(([key]) => key.startsWith('parse-cache/')));
/** Everything a run reports and writes, apart from how it got there. */
const same = (actual, expected, message) => {
  assert.deepEqual(actual.outputs, expected.outputs, message);
  assert.deepEqual(actual.manifest, expected.manifest, message);
  assert.equal(actual.summary, expected.summary, message);
  assert.equal(actual.quarantine, expected.quarantine, message);
  assert.deepEqual(JSON.parse(actual.summary), JSON.parse(expected.summary), message);
};

test('an empty, a full and a partly stale cache give the same output and the same counters', async () => {
  const corpus = memoryCorpus(corpusFolders());
  const cold = await extract(corpus);
  assert.equal(cold.code, 0);
  assert.deepEqual([cold.cache.restored, cold.cache.parsed, cold.cache.unusable], [0, 5, 0]);
  assert.equal(entries(corpus).size, 5, 'one entry per folder');
  // The fixture reaches what it is meant to: every kind of counter is there.
  const stats = JSON.parse(cold.summary);
  for (const counter of ['parseErrors', 'nameVariants', 'declarant_mismatch', 'sourceGroups'])
    assert.ok(stats[counter] > 0, counter);
  assert.ok(stats.dupSkipped > 0);
  assert.match(cold.outputs.filings, /"sourceFolder":"2025y"/);

  const warm = await extract(corpus);
  same(warm, cold, 'a full cache');
  assert.deepEqual([warm.cache.restored, warm.cache.parsed], [5, 0]);
  assert.deepEqual(warm.xmlReads, [], 'a restored folder reads none of its files');
  assert.ok(warm.logs.includes('  2024: 3 declarations from the parse cache'));
  // The parse error is still reported where the folder is decided over, from its record.
  assert.ok(warm.logs.some((l) => l.startsWith('  ! skipped 2023/a3.xml:')));

  // Between runs: a file added (2023), changed (2024), removed (2024y), a folder added (2026) and one
  // removed (2025). Only those folders are parsed; the rest come from the cache.
  const changed = (c) => {
    const f = corpusFolders();
    c.setFolder('2023', [...f[2023], { file: 'a4.xml', name: PETAR }]);
    c.setFolder('2024', [
      f[2024][0],
      f[2024][1],
      { ...f[2024][2], body: declaration(PETAR, { hash: 'B3-NEW' }) },
      f[2024][3],
    ]);
    c.setFolder('2024y', [{ file: 'c2.xml', name: IVAN }]);
    c.setFolder('2026', [{ file: 'e1.xml', name: MARIA }]);
    c.removeFolder('2025');
    c.removeFolder('2025y');
  };
  changed(corpus);
  const partial = await extract(corpus);
  const fresh = memoryCorpus(corpusFolders());
  changed(fresh);
  const coldChanged = await extract(fresh);
  same(partial, coldChanged, 'a partly stale cache');
  assert.notEqual(partial.outputs.filings, cold.outputs.filings, 'the change is in the output');
  assert.deepEqual([partial.cache.restored, partial.cache.parsed], [1, 4]);
  assert.deepEqual([...new Set(partial.xmlReads.map((k) => k.split('/')[0]))].sort(), [
    '2023',
    '2024',
    '2024y',
    '2026',
  ]);
  // What a partly cached run writes is byte for byte what a cold run over the same corpus writes.
  for (const [key, body] of entries(fresh)) assert.deepEqual(entries(corpus).get(key), body, key);

  // And a run with an unchanged folder among changed ones restores it.
  corpus.setFolder('2027', [{ file: 'f1.xml', name: IVAN }]);
  const mixed = await extract(corpus);
  assert.deepEqual([mixed.cache.restored, mixed.cache.parsed], [5, 1]);
  fresh.setFolder('2027', [{ file: 'f1.xml', name: IVAN }]);
  same(mixed, await extract(fresh, { CACBG_PARSE_CACHE: 'off' }), 'a cache-less run');
});

/** A register in which the one company „ТЕСТ ГРУП“ ЕООД shows Иван Тестов Тестов — and, with `alias`,
 *  the same person under the name a later listing uses. Invented identifiers throughout. */
function register(file, { alias }) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE registry_deeds(eik TEXT, name TEXT, legal_form TEXT, outcome TEXT);
    CREATE TABLE registry_identity_snapshots(eik TEXT, source_hash TEXT);
    CREATE TABLE registry_identity_observations(eik TEXT, registry_indent TEXT, name TEXT,
      entry_number TEXT, sub_uic TEXT, field_ident TEXT, holder_index INT, source_hash TEXT,
      subject_kind TEXT, indent_type TEXT, entry_on TEXT);
    INSERT INTO registry_deeds VALUES('999999999','ТЕСТ ГРУП','EOOD','ok');
    INSERT INTO registry_identity_snapshots VALUES('999999999','${'b'.repeat(64)}');`);
  const observe = db.prepare(
    `INSERT INTO registry_identity_observations VALUES('999999999',?,?,?,'','00230',0,?,'person','EGN','2020-01-01')`,
  );
  observe.run('a'.repeat(64), 'ИВАН ТЕСТОВ ТЕСТОВ', '20200101000001', 'c'.repeat(64));
  if (alias) observe.run('a'.repeat(64), 'ИВАН ТЕСТОВ ИВАНОВ', '20210101000001', 'd'.repeat(64));
  db.close();
  return file;
}

test('identity is decided over cached records against the register of this run', async () => {
  const before = register(path.join(dir, 'register-before.sqlite'), { alias: false });
  const after = register(path.join(dir, 'register-after.sqlite'), { alias: true });
  const corpus = memoryCorpus(corpusFolders());
  const first = await extract(corpus, { CACBG_REGISTRY_DB: before });
  assert.equal(first.cache.parsed, 5);
  // The register now proves the listing's other name: the warm run must follow it, not the cache.
  const warm = await extract(corpus, { CACBG_REGISTRY_DB: after });
  assert.deepEqual([warm.cache.restored, warm.cache.parsed], [5, 0]);
  const cold = await extract(memoryCorpus(corpusFolders()), { CACBG_REGISTRY_DB: after });
  same(warm, cold, 'a warm run under a changed register');
  assert.notEqual(warm.outputs.filings, first.outputs.filings);
  assert.ok(JSON.parse(warm.summary).registryAliases > 0, 'the alias is accepted');
  assert.match(warm.outputs.filings, /"identityReason":"verified_registry"/);
});

test('a damaged entry is no entry: it is reported, parsed again and written whole', async () => {
  const corpus = memoryCorpus(corpusFolders());
  const golden = await extract(corpus);
  const keys = [...entries(corpus).keys()];
  const records = (key) => gunzipSync(corpus.objects.get(key)).toString();
  // Cut in half; gzip without its last record; records of another folder; a corrupt gzip stream;
  // whole gzip and an end line, but a record fewer than the end counts.
  const [cut, endless, foreign, flipped, short] = keys;
  corpus.objects.set(cut, corpus.objects.get(cut).subarray(0, 20));
  const lines = records(endless).split('\n').filter(Boolean);
  corpus.objects.set(endless, gzipSync(lines.slice(0, -1).join('\n') + '\n'));
  corpus.objects.set(foreign, corpus.objects.get(keys[4]));
  const bytes = Buffer.from(corpus.objects.get(flipped));
  bytes[bytes.length - 6] ^= 0xff; // inside gzip's CRC trailer
  corpus.objects.set(flipped, bytes);
  const shortLines = records(short).split('\n').filter(Boolean);
  shortLines.splice(
    shortLines.findIndex((line) => line.startsWith('{"list"')),
    1,
  );
  corpus.objects.set(short, gzipSync(shortLines.join('\n') + '\n'));
  const healed = await extract(corpus);
  same(healed, golden, 'after damaged entries');
  assert.deepEqual([healed.cache.restored, healed.cache.parsed, healed.cache.unusable], [0, 5, 5]);
  assert.equal(healed.unusable.length, 5);
  assert.match(healed.unusable.join('\n'), /records without an end/);
  assert.match(healed.unusable.join('\n'), /records of another folder/);
  assert.match(healed.unusable.join('\n'), /the end counts \d+ rows, the records \d+/);
  // Each was written anew, whole: the next run restores all five.
  const again = await extract(corpus);
  assert.deepEqual([again.cache.restored, again.cache.unusable], [5, 0]);
  same(again, golden);
});

test('entries of another parser are not used: every folder is parsed again', async () => {
  const corpus = memoryCorpus(corpusFolders());
  const golden = await extract(corpus);
  // The entries as an earlier parser left them: same folders and inputs, another version.
  for (const [key, body] of entries(corpus)) {
    corpus.objects.delete(key);
    corpus.objects.set(
      key.replace(/^parse-cache\/[0-9a-f]{16}\//, 'parse-cache/0000000000000000/'),
      body,
    );
  }
  const next = await extract(corpus);
  assert.deepEqual([next.cache.restored, next.cache.parsed], [0, 5]);
  same(next, golden);
  // The key of a folder moves with the version and with nothing else of the run.
  const index = JSON.parse(corpus.objects.get('2024/.index.json'));
  const files = await folderFiles(corpus.store, '2024', index);
  const key = (version) => entryKey(corpus.store, '2024', index, files, version);
  assert.notEqual(await key('1111111111111111'), await key('2222222222222222'));
  assert.equal(await key(), await key(parserVersion()));
});

test('the parser version follows every byte of the parser and every module it reaches', () => {
  // A copy of the parse step beside the real one (scratch/ is git-ignored), so its packages resolve.
  fs.mkdirSync(path.resolve('scratch'), { recursive: true });
  const copy = fs.mkdtempSync(path.resolve('scratch', 'parser-version-'));
  try {
    const { modules, packages } = parserClosure();
    assert.deepEqual(
      modules.map((m) => path.relative(path.resolve('scripts/cacbg'), m)),
      ['corpus.mjs', 'extract-parse.mjs', 'guard.mjs', 'parse.mjs'],
    );
    assert.ok(packages.some((p) => p.startsWith('fast-xml-parser@')));
    for (const m of modules) fs.copyFileSync(m, path.join(copy, path.basename(m)));
    const entry = path.join(copy, 'extract-parse.mjs');
    const original = parserVersion();
    assert.match(original, /^[0-9a-f]{16}$/);
    assert.equal(parserVersion(entry), original, 'the same sources are the same version');
    const versionAfter = (edit) => {
      const n = fs.mkdtempSync(path.join(copy, 'v-'));
      for (const m of modules) fs.copyFileSync(m, path.join(n, path.basename(m)));
      edit(n);
      return parserVersion(path.join(n, 'extract-parse.mjs'));
    };
    // One byte of the parser, a comment included.
    const edited = versionAfter((n) =>
      fs.appendFileSync(path.join(n, 'parse.mjs'), '\n// one more line\n'),
    );
    assert.notEqual(edited, original);
    // A module the parser starts to import is part of it from then on.
    const imported = versionAfter((n) => {
      fs.writeFileSync(path.join(n, 'helper.mjs'), 'export const x = 1;\n');
      fs.appendFileSync(path.join(n, 'parse.mjs'), "\nexport { x } from './helper.mjs';\n");
    });
    assert.notEqual(imported, original);
    assert.notEqual(imported, edited);
    // Another release of a package the parser imports, the sources unchanged.
    const released = versionAfter((n) => {
      const pkg = path.join(n, 'node_modules', 'fast-xml-parser');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(
        path.join(pkg, 'package.json'),
        JSON.stringify({ name: 'fast-xml-parser', version: '0.0.0-test' }),
      );
    });
    assert.notEqual(released, original);
    // A dynamic import would hide a module from the walk, so it is refused.
    assert.throws(
      () =>
        versionAfter((n) =>
          fs.appendFileSync(path.join(n, 'parse.mjs'), "\nawait import('./helper.mjs');\n"),
        ),
      /Dynamic import in the parse step/,
    );
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('the inputs key is the folder, its listing and its files by content — nothing else', () => {
  const files = [
    { file: 'a.xml', sha256: '1'.repeat(64) },
    { file: 'b.xml', sha256: '2'.repeat(64), sourceFolder: '2024y' },
  ];
  const base = inputsKey('2024', 'f'.repeat(64), files);
  assert.equal(inputsKey('2024', 'f'.repeat(64), structuredClone(files)), base);
  assert.notEqual(inputsKey('2024y', 'f'.repeat(64), files), base);
  assert.notEqual(inputsKey('2024', 'e'.repeat(64), files), base);
  assert.notEqual(inputsKey('2024', 'f'.repeat(64), files.slice(1)), base);
  assert.notEqual(
    inputsKey('2024', 'f'.repeat(64), [{ ...files[0], sha256: '3'.repeat(64) }, files[1]]),
    base,
  );
  assert.notEqual(
    inputsKey('2024', 'f'.repeat(64), [files[0], { ...files[1], sourceFolder: undefined }]),
    base,
  );
  // A file kept in its own folder is the same input whether or not the index names that folder.
  assert.equal(
    inputsKey('2024', 'f'.repeat(64), [{ ...files[0], sourceFolder: '2024' }, files[1]]),
    base,
  );
});

test('a resumed run takes the folders an earlier attempt parsed from the cache', async () => {
  const corpus = memoryCorpus(corpusFolders());
  const golden = await extract(corpus, { CACBG_PARSE_CACHE: 'off' });
  assert.equal(entries(corpus).size, 0, 'off writes nothing');
  process.env.SIGMA_RUN_ID = '00000000-0000-4000-8000-0000000000a1';
  try {
    assert.equal(await run({ store: corpus.store, yieldAfterFolders: 2 }), 75);
  } finally {
    delete process.env.SIGMA_RUN_ID;
  }
  // A new run (another id, so no checkpoint to adopt) after the container went away.
  const resumed = await extract(corpus, { SIGMA_RUN_ID: '00000000-0000-4000-8000-0000000000b2' });
  same(resumed, golden);
  assert.deepEqual([resumed.cache.restored, resumed.cache.parsed], [2, 3]);
  // `refresh` reads every folder again and writes the same entries.
  const before = entries(corpus);
  const refreshed = await extract(corpus, { CACBG_PARSE_CACHE: 'refresh' });
  assert.deepEqual([refreshed.cache.restored, refreshed.cache.parsed], [0, 5]);
  same(refreshed, golden);
  assert.deepEqual(entries(corpus), before);
  await assert.rejects(extract(corpus, { CACBG_PARSE_CACHE: 'no' }), /CACBG_PARSE_CACHE takes/);
});

test('two runs writing one key leave one whole entry: the same bytes either way', async () => {
  const corpus = memoryCorpus(corpusFolders());
  await extract(corpus);
  const [key, body] = [...entries(corpus)][0];
  // Each run writes from its own disk; the records are the same, so is what lands under the key.
  const copies = ['one', 'two'].map((name) => path.join(dir, `records-${name}.jsonl`));
  for (const copy of copies) fs.writeFileSync(copy, gunzipSync(body));
  const puts = [];
  const store = { remote: true, put: async (k, b) => puts.push([k, Buffer.from(b)]) };
  await Promise.all(copies.map((records) => saveEntry(store, { key, records })));
  assert.deepEqual(puts[0], [key, body]);
  assert.deepEqual(puts[1], [key, body]);
});

test('a restored entry is renewed in the bucket, so its expiry only takes entries no run used', async () => {
  const corpus = memoryCorpus(corpusFolders());
  await extract(corpus);
  const [key, body] = [...entries(corpus)][0];
  const folder = key.split('/')[2];
  const puts = [];
  const store = {
    remote: true,
    get: async (k) => corpus.objects.get(k) ?? null,
    put: async (k, b) => puts.push([k, Buffer.from(b)]),
  };
  const out = path.join(dir, 'restored.jsonl');
  const end = await restoreEntry(store, { key, folder, out });
  assert.ok(end.files > 0);
  assert.deepEqual(puts, [[key, body]]);
  assert.deepEqual(fs.readFileSync(out), gunzipSync(body));
  assert.equal(
    await restoreEntry(store, { key: key.replace(/[0-9a-f]{64}/, '0'.repeat(64)), folder, out }),
    null,
  );
  assert.equal(puts.length, 1, 'nothing to renew when there is no entry');
});

test('a cache that cannot be written costs the next run a parse, never this run', async () => {
  const golden = await extract(memoryCorpus(corpusFolders()), { CACBG_PARSE_CACHE: 'off' });
  const corpus = memoryCorpus(corpusFolders());
  const { put } = corpus.store;
  let failing = true;
  // The store gives up on the cache's writes after its retries; everything else it writes as usual.
  corpus.store.put = async (key, body) => {
    if (failing && key.startsWith('parse-cache/')) throw Error('Corpus request failed: 503');
    return put(key, body);
  };
  const failedLines = (run) =>
    run.logs
      .filter((l) => l.startsWith('{"event":"declarations_parse_cache_write_failed"'))
      .map((l) => JSON.parse(l));

  // Every folder parsed, none kept: the run completes with the output of a run without a cache.
  const cold = await extract(corpus);
  assert.equal(cold.code, 0);
  same(cold, golden, 'a run whose cache writes fail');
  assert.deepEqual([cold.cache.parsed, cold.cache.writeFailed], [5, 5]);
  assert.equal(entries(corpus).size, 0);
  const failed = failedLines(cold);
  assert.deepEqual(
    failed.map((f) => f.folder),
    ['2022', '2023', '2024', '2024y', '2025'],
  );
  assert.match(failed[0].key, /^parse-cache\/[0-9a-f]{16}\/2022\/[0-9a-f]{64}\.jsonl\.gz$/);
  assert.equal(failed[0].reason, 'Corpus request failed: 503');

  // The next run parses those folders again and keeps them.
  failing = false;
  const next = await extract(corpus);
  same(next, golden);
  assert.deepEqual([next.cache.restored, next.cache.parsed, next.cache.writeFailed], [0, 5, 0]);
  assert.equal(entries(corpus).size, 5);

  // A restored entry whose renewal cannot be written is still restored, whole.
  failing = true;
  const warm = await extract(corpus);
  same(warm, golden, 'a run whose renewals fail');
  assert.deepEqual([warm.cache.restored, warm.cache.parsed, warm.cache.writeFailed], [5, 0, 5]);
  assert.equal(failedLines(warm).length, 5);
});

test('cleanup', () => fs.rmSync(dir, { recursive: true, force: true }));
