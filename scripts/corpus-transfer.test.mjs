import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  CORPUS_PREFIX,
  PRODUCTION_BUCKET,
  corpusKey,
  encodePath,
  r2Client,
  resolveCredentials,
  runTransfer,
  signV4,
} from './corpus-transfer.mjs';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const SECRET = 'example-secret-access-key-value';
const FROM = 'sigma-declarations-src';
const TO = 'sigma-declarations-dst';
const md5 = (text) => createHash('md5').update(text).digest('hex');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const C = (rest) => `${CORPUS_PREFIX}${rest}`;

/** One stored object, as the corpus proxy writes it: single-part ETag, sha256 metadata, content type. */
const object = (body, extra = {}) => ({
  size: Buffer.byteLength(body),
  etag: md5(body),
  sha256: sha(body),
  contentType: 'application/xml',
  ...extra,
});

/**
 * A small R2 behind the S3 API: ListObjectsV2 with pages of `page` keys, HEAD, CopyObject with its
 * copy-source condition and metadata. `fault(request)` may answer instead (a Response, or a throw), and
 * every request is recorded — method, path, the headers that matter.
 */
function fakeR2(buckets, { page = 1000, fault = () => undefined, copyEtag } = {}) {
  const requests = [];
  const http = async (url, init) => {
    const u = new URL(url);
    assert.equal(u.host, `${ACCOUNT}.r2.cloudflarestorage.com`);
    assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=key-id\//);
    const [, bucket, ...rest] = u.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    const request = {
      method: init.method,
      bucket,
      key,
      headers: init.headers,
      query: u.searchParams,
    };
    requests.push(request);
    const faulted = await fault(request);
    if (faulted) return faulted;
    const store = buckets[bucket];
    if (!store) return new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 });
    if (init.method === 'GET') {
      const prefix = u.searchParams.get('prefix') ?? '';
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(u.searchParams.get('continuation-token') ?? 0);
      const slice = keys.slice(
        start,
        start + Math.min(page, Number(u.searchParams.get('max-keys'))),
      );
      const truncated = start + slice.length < keys.length;
      const contents = slice
        .map((k) => {
          const o = store.get(k);
          const escaped = k.replace(/&/g, '&amp;').replace(/</g, '&lt;');
          return `<Contents><Key>${escaped}</Key><Size>${o.size}</Size><ETag>&quot;${o.etag}&quot;</ETag></Contents>`;
        })
        .join('');
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>${contents}` +
          (truncated
            ? `<NextContinuationToken>${start + slice.length}</NextContinuationToken>`
            : '') +
          '</ListBucketResult>',
      );
    }
    if (init.method === 'HEAD') {
      const o = store.get(key);
      if (!o) return new Response(null, { status: 404 });
      return new Response(null, {
        headers: {
          etag: `"${o.etag}"`,
          'content-type': o.contentType,
          ...(o.sha256 ? { 'x-amz-meta-sha256': o.sha256 } : {}),
        },
      });
    }
    if (init.method === 'PUT') {
      const [, srcBucket, ...srcRest] = init.headers['x-amz-copy-source'].split('/');
      const srcKey = srcRest.map(decodeURIComponent).join('/');
      const source = buckets[srcBucket]?.get(srcKey);
      if (!source) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      if (init.headers['x-amz-copy-source-if-match'] !== `"${source.etag}"`)
        return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
      store.set(key, { ...source });
      const etag = copyEtag ?? source.etag;
      return new Response(`<CopyObjectResult><ETag>&quot;${etag}&quot;</ETag></CopyObjectResult>`);
    }
    return new Response(null, { status: 405 });
  };
  const pauses = [];
  const client = r2Client({
    accountId: ACCOUNT,
    accessKeyId: 'key-id',
    secretAccessKey: SECRET,
    http,
    pause: async (ms) => void pauses.push(ms),
    now: () => new Date('2026-11-26T10:00:00Z'),
  });
  return { client, requests, pauses };
}

/** The source corpus of every test: two folders, plus the environment state a bucket also holds. */
function sourceBucket() {
  return new Map([
    [C('2024/list.xml'), object('<list>2024</list>')],
    [C('2024/.index.json'), object('{"files":2}', { contentType: 'application/json' })],
    [C('2024/a-001.xml'), object('<d>a1</d>')],
    [C('2024/a-002.xml'), object('<d>a2</d>')],
    [C('2025y/list.xml'), object('<list>2025y</list>')],
    [C('2025y/b-001.xml'), object('<d>b1</d>')],
    [C('2025y/b-002.xml'), object('<d>b2-longer</d>')],
    [C('.corpus-complete.json'), object('{"runId":"src"}')],
    [C('accepted.json'), object('{"runId":"src"}')],
    [C('checkpoints/00000000-0000-4000-8000-000000000000/head.json'), object('{}')],
    [C('fetch-events/00000000-0000-4000-8000-000000000000/1.json'), object('{}')],
    [C('parse-cache/0123456789abcdef/2024/aa.jsonl.gz'), object('gz')],
    ['control/scheduled-pause.json', object('{"until":"x"}')],
  ]);
}

async function run(argv, r2, extra = {}) {
  const lines = [];
  const code = await runTransfer(argv, { client: r2.client, log: (l) => lines.push(l), ...extra });
  return { code, lines, out: lines.join('\n') };
}

const writes = (requests) => requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');

test('only corpus keys are carried: fetched files and folder receipts, never environment state', () => {
  assert.deepEqual(corpusKey(C('2024/a-001.xml')), { folder: '2024', name: 'a-001.xml' });
  assert.deepEqual(corpusKey(C('2021_nc/list.xml')), { folder: '2021_nc', name: 'list.xml' });
  assert.deepEqual(corpusKey(C('2025y/.index.json')), { folder: '2025y', name: '.index.json' });
  for (const key of [
    C('.corpus-complete.json'),
    C('accepted.json'),
    C('checkpoints/00000000-0000-4000-8000-000000000000/head.json'),
    C('fetch-events/00000000-0000-4000-8000-000000000000/1.json'),
    C('parse-cache/0123456789abcdef/2024/aa.jsonl.gz'),
    C('2024/sub/a.xml'),
    C('2024/a.xml/b.xml'),
    C('2024/a.txt'),
    C('1999/a.xml'),
    C('2024/'),
    'control/scheduled-pause.json',
    'declarations/corpus-v1/2024/a.xml',
    '2024/a.xml',
  ])
    assert.equal(corpusKey(key), null, key);
});

test('the signature matches the published SigV4 examples', () => {
  const base = {
    region: 'us-east-1',
    service: 's3',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };
  const headers = {
    host: 'examplebucket.s3.amazonaws.com',
    'x-amz-content-sha256': sha(''),
    'x-amz-date': '20130524T000000Z',
  };
  assert.equal(
    signV4({
      ...base,
      method: 'GET',
      path: '/test.txt',
      headers: { ...headers, range: 'bytes=0-9' },
    }),
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
  assert.match(
    signV4({ ...base, method: 'GET', path: '/', query: { prefix: 'J', 'max-keys': '2' }, headers }),
    /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/,
  );
});

test('plan reads both buckets, reports per folder and writes nothing', async () => {
  const dst = new Map([
    [C('2024/list.xml'), object('<list>2024</list>')],
    [C('2024/a-001.xml'), object('<d>a1-changed</d>')],
    [C('2024/a-999.xml'), object('<d>only here</d>')],
    [C('accepted.json'), object('{"runId":"dst"}')],
  ]);
  const r2 = fakeR2({ [FROM]: sourceBucket(), [TO]: dst });
  const { code, lines } = await run(['plan', '--from', FROM, '--to', TO], r2);
  assert.equal(code, 0);
  assert.deepEqual(writes(r2.requests), []);
  assert.ok(
    lines.includes(
      '2024: source 4 (0.0 KiB), target 3; missing 2 (0.0 KiB), different 1, only in target 1',
    ),
    lines.join('\n'),
  );
  assert.ok(lines.some((l) => l.startsWith('2025y: source 3 (') && l.includes('missing 3')));
  assert.ok(lines.some((l) => l.startsWith('total: source 7 objects') && l.includes('to copy 5')));
  assert.ok(lines.includes(`  different ${C('2024/a-001.xml')}`));
  // Listing only reaches into the folders: the state keys are never even listed.
  assert.ok(r2.requests.every((r) => r.query.get('prefix') === `${CORPUS_PREFIX}20`));
});

test('plan is the default action and says 0 B for nothing to copy', async () => {
  const r2 = fakeR2({ [FROM]: sourceBucket(), [TO]: sourceBucket() });
  const { code, lines } = await run(['--from', FROM, '--to', TO], r2);
  assert.equal(code, 0);
  assert.ok(lines[0].startsWith('plan: '));
  assert.ok(lines.some((l) => l.includes('to copy 0 (0 B); different 0')));
});

test('copy carries only what is missing, leaves different and extra objects, never deletes', async () => {
  const dst = new Map([
    [C('2024/a-001.xml'), object('<d>a1-newer</d>')],
    [C('2024/a-999.xml'), object('<d>only here</d>')],
    [C('accepted.json'), object('{"runId":"dst"}')],
    ['control/scheduled-pause.json', object('{"until":"dst"}')],
  ]);
  const before = new Map(dst);
  const r2 = fakeR2({ [FROM]: sourceBucket(), [TO]: dst });
  const { code, out } = await run(['copy', '--from', FROM, '--to', TO], r2);
  assert.equal(code, 0, out);
  const puts = writes(r2.requests);
  assert.ok(puts.every((r) => r.method === 'PUT' && r.bucket === TO));
  assert.deepEqual(
    puts.map((r) => r.key).sort(),
    [
      '2024/.index.json',
      '2024/a-002.xml',
      '2024/list.xml',
      '2025y/b-001.xml',
      '2025y/b-002.xml',
      '2025y/list.xml',
    ].map(C),
  );
  for (const [key, value] of before) assert.deepEqual(dst.get(key), value, key);
  assert.equal(dst.get(C('.corpus-complete.json')), undefined);
  assert.equal(dst.get(C('checkpoints/00000000-0000-4000-8000-000000000000/head.json')), undefined);
  assert.equal(dst.get(C('parse-cache/0123456789abcdef/2024/aa.jsonl.gz')), undefined);
  assert.match(out, /1 different objects are left as they are; --overwrite-different/);
  assert.match(out, /copied 6 objects/);
  // The folder receipt is the last write: it follows every file the run had to copy.
  assert.equal(puts.at(-1).key, C('2024/.index.json'));
  // The copy names the listed version and keeps the object's metadata.
  const one = puts.find((r) => r.key === C('2024/a-002.xml'));
  assert.equal(one.headers['x-amz-copy-source'], `/${FROM}/${C('2024/a-002.xml')}`);
  assert.equal(one.headers['x-amz-copy-source-if-match'], `"${md5('<d>a2</d>')}"`);
  assert.equal(one.headers['x-amz-metadata-directive'], 'COPY');
  assert.equal(dst.get(C('2024/a-002.xml')).sha256, sha('<d>a2</d>'));
});

test('--overwrite-different replaces a different object with the source', async () => {
  const dst = new Map([[C('2024/a-001.xml'), object('<d>a7</d>')]]);
  const r2 = fakeR2({ [FROM]: sourceBucket(), [TO]: dst });
  const { code } = await run(['copy', '--from', FROM, '--to', TO, '--overwrite-different'], r2);
  assert.equal(code, 0);
  assert.equal(dst.get(C('2024/a-001.xml')).etag, md5('<d>a1</d>'));
});

test('a stopped copy keeps what it copied and the next run carries on from there', async () => {
  let copies = 0;
  const dst = new Map();
  const failing = fakeR2(
    { [FROM]: sourceBucket(), [TO]: dst },
    {
      fault: (r) =>
        r.method === 'PUT' && ++copies > 3
          ? new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })
          : undefined,
    },
  );
  const first = await run(['copy', '--from', FROM, '--to', TO, '--concurrency', '1'], failing);
  assert.equal(first.code, 1);
  assert.match(
    first.out,
    /stopped after 3 of 7: copy into sigma-declarations-dst: HTTP 403 AccessDenied/,
  );
  assert.match(first.out, /run copy again to carry on/);
  assert.equal(dst.size, 3);

  const again = fakeR2({ [FROM]: sourceBucket(), [TO]: dst });
  const second = await run(['copy', '--from', FROM, '--to', TO], again);
  assert.equal(second.code, 0);
  assert.equal(writes(again.requests).length, 4);
  const check = await run(
    ['verify', '--from', FROM, '--to', TO],
    fakeR2({ [FROM]: sourceBucket(), [TO]: dst }),
  );
  assert.equal(check.code, 0, check.out);
});

test('refusals come before any request', async () => {
  const cases = [
    [['copy', '--from', FROM, '--to', FROM], /the source and the target are the same bucket/],
    [
      ['copy', '--from', FROM, '--to', PRODUCTION_BUCKET],
      /production bucket: a person copies into it, with --production/,
    ],
    [['copy', '--from', FROM], /--from and --to are both required/],
    [['move', '--from', FROM, '--to', TO], /unknown action move/],
    [['copy', '--from', FROM, '--to', TO, '--delete'], /unknown argument --delete/],
    [['copy', '--from', FROM, '--to'], /--to needs a value/],
    [['copy', '--from', FROM, '--to', 'Not_A_Bucket'], /not a bucket name/],
    [
      ['copy', '--from', FROM, '--to', TO, '--concurrency', '0'],
      /--concurrency must be a whole number from 1 to 64/,
    ],
    [['verify', '--from', FROM, '--to', TO, '--sample', 'x'], /--sample must be/],
    [['plan', '--from', FROM, '--to', TO, '--folders', '2024,../x'], /unsafe folder/],
  ];
  for (const [argv, message] of cases) {
    const r2 = fakeR2({ [FROM]: sourceBucket(), [TO]: new Map() });
    const { code, out } = await run(argv, r2);
    assert.equal(code, 2, argv.join(' '));
    assert.match(out, message);
    assert.match(out, /usage: corpus-transfer\.mjs/);
    assert.deepEqual(r2.requests, [], argv.join(' '));
  }
});

test('production: plan and verify may read it; copy writes only with --production', async () => {
  const r2 = fakeR2({ [FROM]: sourceBucket(), [PRODUCTION_BUCKET]: new Map() });
  assert.equal((await run(['plan', '--from', FROM, '--to', PRODUCTION_BUCKET], r2)).code, 0);
  assert.deepEqual(writes(r2.requests), []);
  const copy = await run(['copy', '--from', FROM, '--to', PRODUCTION_BUCKET, '--production'], r2);
  assert.equal(copy.code, 0);
  assert.equal(writes(r2.requests).length, 7);
});

test('--folders lists and carries only the named folders', async () => {
  const dst = new Map();
  const r2 = fakeR2({ [FROM]: sourceBucket(), [TO]: dst });
  const { code } = await run(['copy', '--from', FROM, '--to', TO, '--folders', '2025y'], r2);
  assert.equal(code, 0);
  assert.deepEqual(
    [...dst.keys()].sort(),
    ['2025y/b-001.xml', '2025y/b-002.xml', '2025y/list.xml'].map(C),
  );
  assert.ok(
    r2.requests
      .filter((r) => r.method === 'GET')
      .every((r) => r.query.get('prefix') === C('2025y/')),
  );
});

test('verify: per folder count, bytes and fingerprint; 0 only on a full match', async () => {
  const r2 = fakeR2({ [FROM]: sourceBucket(), [TO]: sourceBucket() }, { page: 2 });
  const { code, lines } = await run(['verify', '--from', FROM, '--to', TO, '--deep'], r2);
  assert.equal(code, 0, lines.join('\n'));
  const row = lines.find((l) => l.includes(' 2024: '));
  assert.match(row, /^ok {6}2024: count 4\/4, bytes (\d+)\/\1, fingerprint ([0-9a-f]{16})\/\2$/);
  assert.ok(lines.includes('metadata: 7 of 7 matched objects read head to head, 0 differ'));
  assert.equal(lines.at(-1), 'verify: the target holds the source corpus exactly');
  assert.deepEqual(writes(r2.requests), []);
});

test('verify names every kind of difference by key, capped by --max-lines', async () => {
  const dst = sourceBucket();
  dst.delete(C('2024/a-002.xml'));
  dst.delete(C('2025y/b-001.xml'));
  dst.delete(C('2025y/b-002.xml'));
  dst.set(C('2024/a-001.xml'), object('<d>a9</d>')); // same size, other contents
  dst.set(C('2025y/b-777.xml'), object('<d>extra</d>'));
  const r2 = fakeR2({ [FROM]: sourceBucket(), [TO]: dst });
  const { code, lines } = await run(['verify', '--from', FROM, '--to', TO, '--max-lines', '2'], r2);
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.startsWith('DIFFERS 2024: count 4/3')));
  assert.ok(lines.some((l) => l.startsWith('DIFFERS 2025y: count 3/2')));
  assert.deepEqual(
    lines.filter((l) => l.startsWith('  ')),
    [
      `  missing ${C('2024/a-002.xml')}`,
      `  missing ${C('2025y/b-001.xml')}`,
      '  … and 1 more missing',
      `  different ${C('2024/a-001.xml')}`,
      `  only-in-target ${C('2025y/b-777.xml')}`,
    ],
  );
  assert.equal(lines.at(-1), 'verify: DIFFERENCES — see above');
});

test('verify --allow-extra accepts a target that holds more than the source', async () => {
  const dst = sourceBucket();
  dst.set(C('2025y/b-777.xml'), object('<d>extra</d>'));
  const r2 = fakeR2({ [FROM]: sourceBucket(), [TO]: dst });
  const { code, lines } = await run(['verify', '--from', FROM, '--to', TO, '--allow-extra'], r2);
  assert.equal(code, 0);
  assert.ok(
    lines.some((l) => l.startsWith('ok      2025y: ') && l.endsWith('(1 only in target, allowed)')),
  );
});

test('verify catches a copy that lost the sha256 the corpus reader checks', async () => {
  const dst = sourceBucket();
  dst.set(C('2024/a-001.xml'), { ...dst.get(C('2024/a-001.xml')), sha256: '' });
  dst.set(C('2025y/list.xml'), { ...dst.get(C('2025y/list.xml')), contentType: 'text/plain' });
  const r2 = fakeR2({ [FROM]: sourceBucket(), [TO]: dst });
  const sampled = await run(['verify', '--from', FROM, '--to', TO, '--sample', '0'], r2);
  assert.equal(sampled.code, 0, 'a listing alone cannot see metadata');
  const deep = await run(['verify', '--from', FROM, '--to', TO, '--deep'], r2);
  assert.equal(deep.code, 1);
  assert.ok(deep.lines.includes('metadata: 7 of 7 matched objects read head to head, 2 differ'));
  assert.ok(deep.lines.includes(`  metadata-differs ${C('2024/a-001.xml')}`));
  assert.ok(deep.lines.includes(`  metadata-differs ${C('2025y/list.xml')}`));
});

test('objects written in parts are compared by their stored sha256, not the ETag', async () => {
  const parts = (body, etag) => object(body, { etag });
  const src = new Map([
    [C('2024/a.xml'), parts('<d>same</d>', 'aaaa-2')],
    [C('2024/b.xml'), parts('<d>one</d>', 'bbbb-2')],
  ]);
  const dst = new Map([
    [C('2024/a.xml'), parts('<d>same</d>', 'cccc-3')],
    [C('2024/b.xml'), parts('<d>two</d>', 'dddd-3')],
  ]);
  const r2 = fakeR2({ [FROM]: src, [TO]: dst });
  const { code, lines } = await run(['verify', '--from', FROM, '--to', TO, '--sample', '0'], r2);
  assert.equal(code, 1);
  assert.deepEqual(
    lines.filter((l) => l.startsWith('  ')),
    [`  different ${C('2024/b.xml')}`],
  );
  assert.ok(lines.includes('2 objects written in parts were compared by their stored sha256'));
});

test('passing API failures are tried again with growing pauses', async () => {
  let n = 0;
  const r2 = fakeR2(
    { [FROM]: sourceBucket(), [TO]: sourceBucket() },
    {
      fault: (r) => {
        if (r.bucket !== FROM) return undefined;
        n++;
        if (n === 1) throw new TypeError('fetch failed');
        if (n === 2)
          return new Response('<Error><Code>InternalError</Code></Error>', { status: 500 });
        if (n === 3) return new Response('<Error><Code>SlowDown</Code></Error>', { status: 429 });
        if (n === 4)
          return new Response('<?xml version="1.0"?><Error><Code>InternalError</Code></Error>');
        return undefined;
      },
    },
  );
  const { code } = await run(['plan', '--from', FROM, '--to', TO], r2);
  assert.equal(code, 0);
  assert.deepEqual(r2.pauses, [500, 1000, 2000, 4000]);
});

test('a failure that persists ends the run after five attempts, with a clear message', async () => {
  const r2 = fakeR2(
    { [FROM]: sourceBucket(), [TO]: sourceBucket() },
    { fault: () => new Response('', { status: 503 }) },
  );
  const { code, out } = await run(['plan', '--from', FROM, '--to', TO], r2);
  assert.equal(code, 1);
  assert.match(
    out,
    /failed: list sigma-declarations-(src|dst): HTTP 503 \(gave up after 5 attempts\)/,
  );
  assert.equal(r2.pauses.length, 8, 'four pauses for each bucket');
});

test('timeouts are named and tried again', async () => {
  const r2 = fakeR2(
    { [FROM]: sourceBucket(), [TO]: sourceBucket() },
    {
      fault: () => {
        throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      },
    },
  );
  const { code, out } = await run(['plan', '--from', FROM, '--to', TO, '--folders', '2024'], r2);
  assert.equal(code, 1);
  assert.match(out, /list sigma-declarations-(src|dst): timed out \(gave up after 5 attempts\)/);
});

test('a refusal is not tried again and never prints the credentials', async () => {
  const r2 = fakeR2(
    { [FROM]: sourceBucket(), [TO]: sourceBucket() },
    {
      fault: () =>
        new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 }),
    },
  );
  const { code, out } = await run(['plan', '--from', FROM, '--to', TO], r2);
  assert.equal(code, 1);
  assert.match(out, /HTTP 403 SignatureDoesNotMatch/);
  assert.deepEqual(r2.pauses, []);
  assert.ok(!out.includes(SECRET) && !out.includes('key-id') && !out.includes('AWS4'));
});

test('a missing bucket, a broken listing and a source that changed all stop the run', async () => {
  const missing = await run(
    ['plan', '--from', FROM, '--to', 'sigma-declarations-none'],
    fakeR2({ [FROM]: sourceBucket() }),
  );
  assert.equal(missing.code, 1);
  assert.match(missing.out, /list sigma-declarations-none: HTTP 404 NoSuchBucket/);

  for (const body of [
    '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>',
    '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken></NextContinuationToken></ListBucketResult>',
    '<html>not s3</html>',
  ]) {
    const r2 = fakeR2(
      { [FROM]: sourceBucket(), [TO]: sourceBucket() },
      { fault: (r) => (r.method === 'GET' ? new Response(body) : undefined) },
    );
    const { code, out } = await run(['plan', '--from', FROM, '--to', TO], r2);
    assert.equal(code, 1, body);
    assert.match(out, /the listing did not advance|not a listing/);
  }
  let pages = 0;
  const looping = fakeR2(
    { [FROM]: sourceBucket(), [TO]: sourceBucket() },
    {
      fault: (r) =>
        r.method === 'GET' && ++pages
          ? new Response(
              '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>same</NextContinuationToken></ListBucketResult>',
            )
          : undefined,
    },
  );
  assert.match(
    (await run(['plan', '--from', FROM, '--to', TO, '--folders', '2024'], looping)).out,
    /did not advance/,
  );

  const src = sourceBucket();
  const changed = fakeR2(
    { [FROM]: src, [TO]: new Map() },
    {
      fault: (r) => {
        if (r.method === 'PUT') src.set(C('2024/a-001.xml'), object('<d>rewritten</d>'));
      },
    },
  );
  const copy = await run(['copy', '--from', FROM, '--to', TO, '--concurrency', '1'], changed);
  assert.equal(copy.code, 1);
  assert.match(copy.out, /HTTP 412 PreconditionFailed/);
});

test('a copy whose checksum differs from the source stops the run', async () => {
  const r2 = fakeR2({ [FROM]: sourceBucket(), [TO]: new Map() }, { copyEtag: 'ffff' });
  const { code, out } = await run(['copy', '--from', FROM, '--to', TO], r2);
  assert.equal(code, 1);
  assert.match(out, /the copy's checksum differs from the source/);
});

test('an unexpected error is not swallowed as a refusal', async () => {
  const client = {
    async *list() {
      yield* [];
      throw new RangeError('bug');
    },
  };
  await assert.rejects(
    runTransfer(['plan', '--from', FROM, '--to', TO], { client, log: () => {} }),
    RangeError,
  );
  const copying = {
    async *list(bucket) {
      if (bucket === FROM) yield { key: C('2024/a.xml'), size: 1, etag: 'aa' };
    },
    async copy() {
      throw new RangeError('bug');
    },
  };
  await assert.rejects(
    runTransfer(['copy', '--from', FROM, '--to', TO], { client: copying, log: () => {} }),
    RangeError,
  );
});

test('credentials: explicit S3 keys, or derived from the API token without printing either', async () => {
  const token = 'example-api-token-value';
  assert.deepEqual(
    await resolveCredentials(
      { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 's' },
      () => assert.fail('no request when the keys are given'),
    ),
    { accountId: ACCOUNT, accessKeyId: 'id', secretAccessKey: 's' },
  );
  const asked = [];
  const verify = (answers) => async (url, init) => {
    asked.push(url.replace(ACCOUNT, '<account>'));
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    return Response.json(answers.shift(), { status: 200 });
  };
  const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: token };
  assert.deepEqual(
    await resolveCredentials(
      env,
      verify([{ success: true, result: { id: 'tok-id', status: 'active' } }]),
    ),
    {
      accountId: ACCOUNT,
      accessKeyId: 'tok-id',
      secretAccessKey: sha(token),
    },
  );
  asked.length = 0;
  const user = await resolveCredentials(
    env,
    verify([{ success: false }, { success: true, result: { id: 'user-id', status: 'active' } }]),
  );
  assert.equal(user.accessKeyId, 'user-id');
  assert.deepEqual(asked, [
    'https://api.cloudflare.com/client/v4/accounts/<account>/tokens/verify',
    'https://api.cloudflare.com/client/v4/user/tokens/verify',
  ]);
  await assert.rejects(
    resolveCredentials(
      env,
      verify([{ success: true, result: { id: 'x', status: 'disabled' } }, { success: false }]),
    ),
    /not an active token/,
  );
  await assert.rejects(
    resolveCredentials(env, async () => new Response('not json', { status: 401 })),
    /not an active token/,
  );
  await assert.rejects(
    resolveCredentials({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT }),
    /set R2_ACCESS_KEY_ID/,
  );
  assert.throws(
    () => r2Client({ accountId: 'nope' }),
    /CLOUDFLARE_ACCOUNT_ID is missing or malformed/,
  );
});

test('paths are encoded as SigV4 wants them, slashes kept', () => {
  assert.equal(encodePath("a b/c&d/(x)*!'"), 'a%20b/c%26d/%28x%29%2A%21%27');
  assert.equal(encodePath(C('2021_nc/a-1.xml')), C('2021_nc/a-1.xml'));
});

test('the command line refuses without credentials and prints no secret', () => {
  const env = { PATH: process.env.PATH, CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
  const res = spawnSync(
    process.execPath,
    ['scripts/corpus-transfer.mjs', 'plan', '--from', FROM, '--to', TO],
    {
      env,
      encoding: 'utf8',
    },
  );
  assert.equal(res.status, 2);
  assert.match(
    res.stderr,
    /refused: set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, or CLOUDFLARE_API_TOKEN/,
  );
});

test('no arguments is a plan without buckets, refused', async () => {
  const r2 = fakeR2({});
  const { code, out } = await run([], r2);
  assert.equal(code, 2);
  assert.match(out, /--from and --to are both required/);
});

test('sizes read in MiB and GiB', async () => {
  const src = new Map([
    [C('2024/a.xml'), object('<d>a</d>', { size: 3 * 1024 ** 3 })],
    [C('2025/a.xml'), object('<d>b</d>', { size: 5 * 1024 ** 2 })],
  ]);
  const { lines } = await run(
    ['plan', '--from', FROM, '--to', TO],
    fakeR2({ [FROM]: src, [TO]: new Map() }),
  );
  assert.ok(lines.some((l) => l.startsWith('2024: source 1 (3.00 GiB)')));
  assert.ok(lines.some((l) => l.startsWith('2025: source 1 (5.0 MiB)')));
});

test('the continuation token and keys are read back unescaped', async () => {
  const pages = [];
  const r2 = fakeR2(
    { [FROM]: sourceBucket(), [TO]: sourceBucket() },
    {
      fault: (r) => {
        if (r.method !== 'GET' || r.bucket !== FROM) return undefined;
        pages.push(r.query.get('continuation-token'));
        return new Response(
          pages.length === 1
            ? `<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>${C('2024/a-001.xml')}</Key><Size>1</Size><ETag>&#34;aa&#x22;</ETag></Contents><NextContinuationToken>t&#43;1&amp;&lt;&gt;&apos;</NextContinuationToken></ListBucketResult>`
            : '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
        );
      },
    },
  );
  const { lines } = await run(['plan', '--from', FROM, '--to', TO, '--folders', '2024'], r2);
  assert.deepEqual(pages, [null, "t+1&<>'"]);
  assert.ok(lines.some((l) => l.startsWith('2024: source 1 (')));
});

test('verify counts an object that vanished between listing and reading as differing', async () => {
  const r2 = fakeR2(
    { [FROM]: sourceBucket(), [TO]: sourceBucket() },
    {
      fault: (r) =>
        r.method === 'HEAD' && r.bucket === TO ? new Response(null, { status: 404 }) : undefined,
    },
  );
  const { code, lines } = await run(['verify', '--from', FROM, '--to', TO, '--deep'], r2);
  assert.equal(code, 1);
  assert.ok(lines.includes('metadata: 7 of 7 matched objects read head to head, 7 differ'));
});

test('a copy of an object written in parts is not held to the source ETag', async () => {
  const src = new Map([[C('2024/a.xml'), object('<d>a</d>', { etag: 'abcd-2' })]]);
  const dst = new Map();
  const r2 = fakeR2({ [FROM]: src, [TO]: dst }, { copyEtag: 'ef01' });
  assert.equal((await run(['copy', '--from', FROM, '--to', TO], r2)).code, 0);
  assert.ok(dst.has(C('2024/a.xml')));
});

test('a folder only the target holds is reported, and fails verify', async () => {
  const dst = sourceBucket();
  dst.set(C('2026/c-001.xml'), object('<d>c1</d>'));
  const r2 = fakeR2({ [FROM]: sourceBucket(), [TO]: dst });
  const plan = await run(['plan', '--from', FROM, '--to', TO], r2);
  assert.ok(
    plan.lines.includes(
      '2026: source 0 (0 B), target 1; missing 0 (0 B), different 0, only in target 1',
    ),
  );
  const verify = await run(['verify', '--from', FROM, '--to', TO], r2);
  assert.equal(verify.code, 1);
  assert.ok(verify.lines.some((l) => l.startsWith('DIFFERS 2026: count 0/1, bytes 0/')));
});

test('a long copy reports its progress in about twenty steps', async () => {
  const src = new Map(
    Array.from({ length: 45 }, (_, i) => [
      C(`2024/a-${String(i).padStart(3, '0')}.xml`),
      object(`<d>${i}</d>`),
    ]),
  );
  const r2 = fakeR2({ [FROM]: src, [TO]: new Map() });
  const { code, lines } = await run(['copy', '--from', FROM, '--to', TO], r2);
  assert.equal(code, 0);
  const progress = lines.filter((l) => l.startsWith('copied ') && l.includes('/45'));
  assert.equal(progress.length, 15); // every third object
  assert.match(progress.at(-1), /^copied 45\/45 \(/);
});

test('objects of different sizes differ without reading their heads', async () => {
  const src = new Map([[C('2024/a.xml'), object('<d>one</d>', { etag: 'aaaa-2' })]]);
  const dst = new Map([[C('2024/a.xml'), object('<d>three</d>', { etag: 'aaaa-2' })]]);
  const r2 = fakeR2({ [FROM]: src, [TO]: dst });
  const { code, lines } = await run(['verify', '--from', FROM, '--to', TO, '--sample', '0'], r2);
  assert.equal(code, 1);
  assert.deepEqual(
    lines.filter((l) => l.startsWith('  ')),
    [`  different ${C('2024/a.xml')}`],
  );
  assert.equal(r2.requests.filter((r) => r.method === 'HEAD').length, 0);
});

test('a copy stopped inside a folder leaves no receipt for it; the next run finishes the folder', async () => {
  const dst = new Map();
  const failing = fakeR2(
    { [FROM]: sourceBucket(), [TO]: dst },
    {
      fault: (r) =>
        r.method === 'PUT' && r.key === C('2024/list.xml')
          ? new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })
          : undefined,
    },
  );
  const first = await run(['copy', '--from', FROM, '--to', TO, '--concurrency', '1'], failing);
  assert.equal(first.code, 1);
  assert.ok(dst.has(C('2024/a-001.xml')) && dst.has(C('2024/a-002.xml')), first.out);
  assert.equal(dst.has(C('2024/.index.json')), false, 'a receipt over a folder that is not whole');
  assert.match(first.out, /1 folder receipts were held back/);

  const again = fakeR2({ [FROM]: sourceBucket(), [TO]: dst });
  const second = await run(['copy', '--from', FROM, '--to', TO, '--concurrency', '1'], again);
  assert.equal(second.code, 0, second.out);
  assert.deepEqual(
    writes(again.requests).map((r) => r.key),
    [
      '2024/list.xml',
      '2025y/b-001.xml',
      '2025y/b-002.xml',
      '2025y/list.xml',
      '2024/.index.json',
    ].map(C),
  );
  const check = await run(
    ['verify', '--from', FROM, '--to', TO],
    fakeR2({ [FROM]: sourceBucket(), [TO]: dst }),
  );
  assert.equal(check.code, 0, check.out);
});

test('with --overwrite-different a receipt is replaced only after the files of every folder', async () => {
  const stale = object('{"files":1}', { contentType: 'application/json' });
  const build = () =>
    new Map([
      [C('2024/list.xml'), object('<list>2024</list>')],
      [C('2024/.index.json'), stale],
      [C('2024/a-001.xml'), object('<d>a7</d>')],
    ]);
  const ok = build();
  const r2 = fakeR2({ [FROM]: sourceBucket(), [TO]: ok });
  const copied = await run(['copy', '--from', FROM, '--to', TO, '--overwrite-different'], r2);
  assert.equal(copied.code, 0, copied.out);
  assert.equal(writes(r2.requests).at(-1).key, C('2024/.index.json'));
  assert.equal(ok.get(C('2024/.index.json')).etag, md5('{"files":2}'));

  const dst = build();
  const failing = fakeR2(
    { [FROM]: sourceBucket(), [TO]: dst },
    {
      fault: (r) =>
        r.method === 'PUT' && r.key === C('2024/a-001.xml')
          ? new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })
          : undefined,
    },
  );
  const stopped = await run(
    ['copy', '--from', FROM, '--to', TO, '--overwrite-different', '--concurrency', '2'],
    failing,
  );
  assert.equal(stopped.code, 1);
  assert.equal(dst.get(C('2024/.index.json')), stale, 'the receipt waits for its folder');
});

test('a failed copy starts no new copies, with many in flight, and the run fails', async () => {
  const src = new Map(
    Array.from({ length: 40 }, (_, i) => [
      C(`2024/a-${String(i).padStart(3, '0')}.xml`),
      object(`<d>${i}</d>`),
    ]),
  );
  let puts = 0;
  const r2 = fakeR2(
    { [FROM]: src, [TO]: new Map() },
    {
      fault: (r) =>
        r.method === 'PUT' && ++puts === 1
          ? new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })
          : undefined,
    },
  );
  const { code, out } = await run(['copy', '--from', FROM, '--to', TO, '--concurrency', '4'], r2);
  assert.equal(code, 1);
  assert.match(out, /stopped after [0-3] of 40: copy into sigma-declarations-dst: HTTP 403/);
  assert.ok(writes(r2.requests).length <= 4, `${writes(r2.requests).length} copies were started`);
});
