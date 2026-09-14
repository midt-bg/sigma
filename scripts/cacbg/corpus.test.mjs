import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { corpusStore, corpusFiles, CORPUS_STAMP, digest } from './corpus.mjs';
import { run as crawl } from './fetch.mjs';

test('two time slices resume the same durable XML set and only the complete pass seals it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-crawl-resume-'));
  const objects = new Map(),
    requests = [];
  const store = {
    remote: true,
    get: async (key) => objects.get(key) ?? null,
    put: async (key, body) => {
      objects.set(key, body);
    },
    remove: async (key) => {
      objects.delete(key);
    },
    files: async (folder) =>
      new Map(
        [...objects]
          .filter(([key]) => key.startsWith(folder + '/') && key.endsWith('.xml'))
          .map(([key, body]) => [key.split('/')[1], digest(body)]),
      ),
  };
  const list =
    '<root><MainCategory><Category Name="Annual"><Institution Name="Test"><Person><Name>Test Person</Name><Position><Name>Director</Name>' +
    ['a', 'b', 'c'].map((n) => `<Declaration><xmlFile>${n}.xml</xmlFile></Declaration>`).join('') +
    '</Position></Person></Institution></Category></MainCategory></root>';
  let clock = 0;
  const httpGet = async (url) => {
    const file = url.split('/').at(-1);
    if (file !== 'list.xml') {
      requests.push(file);
      clock += 60001;
    }
    return { status: 200, body: Buffer.from(file === 'list.xml' ? list : '<xml/>') };
  };
  const pass = () =>
    crawl({
      store,
      rawDir: dir,
      guard: () => {},
      discover: async () => ['2025'],
      httpGet,
      now: () => clock,
      argv: ['--concurrency', '1', '--deadline-minutes', '1', '--yield-on-deadline'],
    });
  try {
    assert.equal(await pass(), 75);
    assert(!objects.has(CORPUS_STAMP));
    clock = 0;
    assert.equal(await pass(), 75);
    assert(!objects.has(CORPUS_STAMP));
    clock = 0;
    assert.equal(await pass(), 0);
    assert.deepEqual(requests, ['a.xml', 'b.xml', 'c.xml']);
    assert.equal(JSON.parse(objects.get(CORPUS_STAMP)).incomplete, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2 prefetch overlaps bounded reads, preserves file order and propagates read failures', async () => {
  let active = 0,
    peak = 0;
  const files = Array.from({ length: 11 }, (_, n) => ({ file: `${n}.xml` }));
  const store = {
    get: async (key) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, key.endsWith('/0.xml') ? 15 : 1));
      active--;
      return Buffer.from(key);
    },
  };
  const result = [];
  for await (const entry of corpusFiles(store, '2025', files, 4)) result.push(entry.file);
  assert.equal(peak, 4);
  assert.deepEqual(
    result,
    files.map((f) => f.file),
  );
  await assert.rejects(async () => {
    for await (const entry of corpusFiles(
      {
        get: async () => {
          throw Error('R2 unavailable');
        },
      },
      '2025',
      files,
    ))
      void entry;
  }, /R2 unavailable/);
});

test('R2 crawl resumes per object, extracts the same records without a disk corpus, and rejects changed inputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-r2-corpus-'));
  process.env.CACBG_RAW = join(dir, 'raw');
  process.env.CACBG_STAGING = join(dir, 'staging');
  const objects = new Map();
  const http = async (url, options = {}) => {
    const u = new URL(url),
      key = decodeURI(u.pathname.slice(1));
    if (!key) {
      // Deliberately paginate after one object, including non-XML objects.
      const all = [...objects.keys()]
        .filter((k) => k.startsWith(u.searchParams.get('prefix')))
        .sort();
      const start = Number(u.searchParams.get('cursor') || 0),
        keys = all.slice(start, start + 1);
      return Response.json({
        objects: keys.map((key) => ({ key, sha256: digest(objects.get(key)) })),
        truncated: start + 1 < all.length,
        cursor: String(start + 1),
      });
    }
    if (options.method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (options.method === 'PUT') {
      assert.equal(options.headers['x-corpus-sha256'], digest(options.body));
      objects.set(key, Buffer.from(options.body));
      return new Response(null, { status: 204 });
    }
    const body = objects.get(key);
    return body
      ? new Response(body, { headers: { 'x-corpus-sha256': digest(body) } })
      : new Response(null, { status: 404 });
  };
  const remote = corpusStore(join(dir, 'never-created'), 'http://declarations.r2', http);
  const name = 'Иван Петров Тестов';
  const list = `<root><MainCategory><Category Name="Годишни"><Institution Name="Тест"><Person><Name>${name}</Name><Position><Name>Директор</Name>${['a.xml', 'b.xml', 'gap.xml'].map((f) => `<Declaration><xmlFile>${f}</xmlFile></Declaration>`).join('')}</Position></Person></Institution></Category></MainCategory></root>`;
  const xml = (n) =>
    `<PublicPerson><Personal><Name>${name}</Name><Work>Тест</Work></Personal><DeclarationData><Year>2025</Year><ControlHash>${n}</ControlHash><DeclarationType>Annualy</DeclarationType></DeclarationData><Tables/></PublicPerson>`;
  let fail = true;
  const requested = [];
  const source = async (url) => {
    const file = url.split('/').at(-1);
    requested.push(file);
    const status = file === 'gap.xml' ? 404 : file === 'b.xml' && fail ? 503 : 200;
    return { status, body: Buffer.from(file === 'list.xml' ? list : xml(file)) };
  };
  const fetchCorpus = (store) =>
    crawl({
      rawDir: join(dir, 'raw'),
      store,
      httpGet: source,
      discover: async () => ['2025'],
      guard: () => {},
      argv: ['--concurrency', '1'],
    });
  try {
    assert.equal(await fetchCorpus(remote), 1);
    assert(objects.has('2025/a.xml'));
    assert(!objects.has(CORPUS_STAMP));
    fail = false;
    requested.length = 0;
    assert.equal(await fetchCorpus(remote), 0);
    assert(!requested.includes('a.xml'), 'a committed XML must not be fetched again');
    assert(!existsSync(join(dir, 'raw')), 'R2 mode must not create a local raw corpus');
    assert([...objects.keys()].every((k) => !/\.(tgz|gz|tar)$/.test(k)));
    const local = corpusStore(join(dir, 'raw'), null);
    assert.equal(await fetchCorpus(local), 0);
    const { run: extract } = await import('./extract.mjs');
    await extract({ store: local });
    const files = [
      'holdings',
      'related',
      'filings',
      'source-groups',
      'source-quarantine',
      'registry-requests',
    ];
    const expected = files.map((f) => readFileSync(join(dir, 'staging', f + '.jsonl'), 'utf8'));
    rmSync(join(dir, 'raw'), { recursive: true });
    await extract({ store: remote });
    assert.deepEqual(
      files.map((f) => readFileSync(join(dir, 'staging', f + '.jsonl'), 'utf8')),
      expected,
    );
    assert(!existsSync(join(dir, 'raw')));
    objects.set('2025/a.xml', Buffer.from(xml('changed')));
    await assert.rejects(() => extract({ store: remote }), /file missing or changed/);
    assert(!existsSync(join(dir, 'staging', 'manifest.json')));
    objects.delete('2025/a.xml');
    await assert.rejects(() => extract({ store: remote }), /file missing or changed/);
    objects.delete(CORPUS_STAMP);
    await assert.rejects(() => extract({ store: remote }), /REFUSE TO EXTRACT/);
    await assert.rejects(() => remote.get('../outside.xml'), /Invalid corpus|unsafe folder/);
    assert.throws(() => corpusStore(dir, 'https://public.example'), /private corpus/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.CACBG_RAW;
    delete process.env.CACBG_STAGING;
  }
});
