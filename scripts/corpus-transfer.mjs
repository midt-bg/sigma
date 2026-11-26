#!/usr/bin/env node
// Carry the declarations corpus from one environment's bucket to another's (docs/deploy.md, „Пренос на
// корпуса между среди“). Only the corpus moves: the raw files the crawler fetched and the per-folder
// receipts it sealed. The environment's own state — the scheduled hold, the run's stamp and audit receipt,
// checkpoints, fetch events, the parse cache, anything not shaped like a corpus key — is never read for
// copying, never written and never compared.
//
//   node scripts/corpus-transfer.mjs plan   --from <bucket> --to <bucket> [--folders 2025,2025y]
//   node scripts/corpus-transfer.mjs copy   --from <bucket> --to <bucket> [--concurrency 32]
//                                            [--overwrite-different] [--production]
//   node scripts/corpus-transfer.mjs verify --from <bucket> --to <bucket> [--sample 200 | --deep]
//                                            [--allow-extra] [--max-lines 20]
//
// Through R2's S3-compatible API: listing is a thousand keys a request, and CopyObject copies inside
// Cloudflare, so nothing is downloaded. The S3 keys are R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY when set;
// otherwise they are derived from the Cloudflare API token already in the shell (the key id is the token's
// id, the secret is the SHA-256 of the token), which needs the same Workers R2 Storage permission the
// deploy uses. No resource is created. No secret is ever printed.
import { createHash, createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { isXmlFile, safeFolder } from './cacbg/guard.mjs';

/** Where the corpus proxy (apps/etl/src/declaration-corpus.ts) keeps every corpus object. */
export const CORPUS_PREFIX = 'declarations/corpus-v2/';
/** The production declarations bucket (docs/deploy.md). A human operator writes there, never an agent. */
export const PRODUCTION_BUCKET = 'sigma-declarations';
const FOLDER = /^20\d{2}[A-Za-z0-9_]{0,8}$/;
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const ATTEMPTS = 5;
const RECEIPT = '.index.json';

/**
 * The corpus part of a bucket key: `{ folder, name }` for a file the crawler fetched (`list.xml` and the
 * declarations) or the receipt it sealed for a folder (`.index.json`); null for everything else. An
 * allowlist on purpose — a prefix nobody told this script about is environment state until proven not.
 */
export function corpusKey(key) {
  if (!key.startsWith(CORPUS_PREFIX)) return null;
  const parts = key.slice(CORPUS_PREFIX.length).split('/');
  if (parts.length !== 2 || !FOLDER.test(parts[0])) return null;
  if (parts[1] !== RECEIPT && !isXmlFile(parts[1])) return null;
  return { folder: parts[0], name: parts[1] };
}

// ── S3 (SigV4) ────────────────────────────────────────────────────────────────────────────────────────

const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
/** RFC 3986 encoding, as SigV4 wants it: everything but the unreserved characters. */
const encode = (text) =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
export const encodePath = (path) => path.split('/').map(encode).join('/');

/**
 * The Authorization header of an AWS Signature Version 4 request. `path` is already encoded; `query` is a
 * plain object; `headers` are lower-case and must include host, x-amz-date and x-amz-content-sha256.
 */
export function signV4({
  method,
  path,
  query = {},
  headers,
  region,
  service,
  accessKeyId,
  secretAccessKey,
}) {
  const date = headers['x-amz-date'];
  const scope = `${date.slice(0, 8)}/${region}/${service}/aws4_request`;
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encode(k)}=${encode(String(query[k]))}`)
    .join('&');
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = [
    method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    headers['x-amz-content-sha256'],
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
  let key = hmac(`AWS4${secretAccessKey}`, date.slice(0, 8));
  for (const part of [region, service, 'aws4_request']) key = hmac(key, part);
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

const unescapeXml = (text) =>
  text.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-fA-F]+));/g, (_, name, dec, hex) =>
    dec
      ? String.fromCodePoint(Number(dec))
      : hex
        ? String.fromCodePoint(parseInt(hex, 16))
        : { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[name],
  );
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? unescapeXml(m[1]) : undefined;
};
const etagOf = (value) => (value ?? '').replace(/^(W\/)?"|"$/g, '');

/** A failure that another attempt cannot fix: the run stops on it and says what it was. */
class Fatal extends Error {}

/**
 * The few S3 calls the transfer needs, over an injected `fetch` and `pause`, so every path is tested
 * without Cloudflare. Network errors, 429 and 5xx are tried again with growing pauses, up to five
 * attempts; anything else ends the run with the status and S3's error code — never a header or a secret.
 */
export function r2Client({
  accountId,
  accessKeyId,
  secretAccessKey,
  http = fetch,
  pause = sleep,
  now = () => new Date(),
}) {
  if (!/^[0-9a-f]{32}$/.test(accountId ?? ''))
    throw new Fatal('CLOUDFLARE_ACCOUNT_ID is missing or malformed');
  const host = `${accountId}.r2.cloudflarestorage.com`;
  async function request(
    method,
    bucket,
    key,
    { query = {}, headers = {}, what, allow404 = false },
  ) {
    const path = `/${encode(bucket)}${key === undefined ? '' : `/${encodePath(key)}`}`;
    const search = Object.keys(query)
      .sort()
      .map((k) => `${encode(k)}=${encode(String(query[k]))}`)
      .join('&');
    for (let attempt = 1; ; attempt++) {
      const signed = {
        ...headers,
        host,
        'x-amz-content-sha256': EMPTY_SHA256,
        'x-amz-date': now()
          .toISOString()
          .replace(/[-:]|\.\d{3}/g, ''),
      };
      signed.authorization = signV4({
        method,
        path,
        query,
        headers: signed,
        region: 'auto',
        service: 's3',
        accessKeyId,
        secretAccessKey,
      });
      delete signed.host;
      let res;
      let failure;
      try {
        res = await http(`https://${host}${path}${search ? `?${search}` : ''}`, {
          method,
          headers: signed,
          redirect: 'error',
          signal: AbortSignal.timeout(60_000),
        });
        const body = method === 'HEAD' ? '' : await res.text();
        // CopyObject can answer 200 and still carry an <Error> in its body; S3 says to retry those.
        const error = /^\s*(<\?xml[^>]*>\s*)?<Error>/.test(body);
        if ((res.ok && !error) || (res.status === 404 && allow404)) return { res, body };
        const code = tag(body, 'Code') ?? '';
        failure = `${what}: HTTP ${res.status}${code ? ` ${code}` : ''}`;
        if (!res.ok && res.status !== 429 && res.status < 500) throw new Fatal(failure);
      } catch (error) {
        if (error instanceof Fatal) throw error;
        failure = `${what}: ${error?.name === 'TimeoutError' ? 'timed out' : 'network error'}`;
      }
      if (attempt === ATTEMPTS) throw new Fatal(`${failure} (gave up after ${ATTEMPTS} attempts)`);
      await pause(500 * 2 ** (attempt - 1));
    }
  }
  return {
    /** Every object under `prefix`, a thousand a page, as `{ key, size, etag }`. */
    async *list(bucket, prefix) {
      let token;
      do {
        const query = { 'list-type': '2', prefix, 'max-keys': '1000' };
        if (token) query['continuation-token'] = token;
        const { body } = await request('GET', bucket, undefined, { query, what: `list ${bucket}` });
        if (!/<ListBucketResult[\s>]/.test(body)) throw new Fatal(`list ${bucket}: not a listing`);
        for (const [, item] of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g))
          yield {
            key: tag(item, 'Key'),
            size: Number(tag(item, 'Size')),
            etag: etagOf(tag(item, 'ETag')),
          };
        // A truncated page without a fresh token would end the listing early and quietly: a short
        // inventory reads as „missing in the target" or, worse, as a match over half the corpus.
        const truncated = tag(body, 'IsTruncated') === 'true';
        const next = truncated ? tag(body, 'NextContinuationToken') : undefined;
        if (truncated && (!next || next === token))
          throw new Fatal(`list ${bucket}: the listing did not advance`);
        token = next;
      } while (token);
    },
    /** The object's stored checksum and type, or null when it is not there. */
    async head(bucket, key) {
      const { res } = await request('HEAD', bucket, key, {
        what: `head ${bucket}`,
        allow404: true,
      });
      if (res.status === 404) return null;
      return {
        sha256: res.headers.get('x-amz-meta-sha256') ?? '',
        contentType: res.headers.get('content-type') ?? '',
        etag: etagOf(res.headers.get('etag')),
      };
    },
    /**
     * A server-side copy of the version that was listed (`etag`): if the source changed since, R2 refuses
     * with 412 and the copy stops rather than carry something nobody compared. Metadata — the sha256 the
     * corpus reader checks every body against, and the content type — travels with the object.
     */
    async copy(from, to, key, etag) {
      const { body } = await request('PUT', to, key, {
        headers: {
          'x-amz-copy-source': `/${encode(from)}/${encodePath(key)}`,
          'x-amz-copy-source-if-match': `"${etag}"`,
          'x-amz-metadata-directive': 'COPY',
        },
        what: `copy into ${to}`,
      });
      const copied = etagOf(tag(body, 'ETag'));
      if (!etag.includes('-') && copied !== etag)
        throw new Fatal(`copy into ${to}: the copy's checksum differs from the source`);
    },
  };
}

/**
 * The S3 keys: R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY when both are set, otherwise derived from the
 * Cloudflare API token (Cloudflare documents an R2-permitted token as S3 credentials: its id as the key id,
 * the SHA-256 of its value as the secret). The id is read from the token-verify endpoint, account token
 * first, then user token.
 */
export async function resolveCredentials(env, http = fetch) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY)
    return {
      accountId,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    };
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token)
    throw new Fatal('set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, or CLOUDFLARE_API_TOKEN');
  for (const path of [`accounts/${accountId}/tokens/verify`, 'user/tokens/verify']) {
    const res = await http(`https://api.cloudflare.com/client/v4/${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.success && body.result?.status === 'active' && body.result.id)
      return { accountId, accessKeyId: body.result.id, secretAccessKey: sha256(token) };
  }
  throw new Fatal('CLOUDFLARE_API_TOKEN is not an active token');
}

// ── The transfer ──────────────────────────────────────────────────────────────────────────────────────

/** Corpus objects of a bucket, by folder and file name; other keys are not kept. */
async function inventory(client, bucket, folders) {
  const byFolder = new Map();
  for (const prefix of folders
    ? folders.map((f) => `${CORPUS_PREFIX}${f}/`)
    : [`${CORPUS_PREFIX}20`]) {
    for await (const object of client.list(bucket, prefix)) {
      const part = corpusKey(object.key);
      if (!part) continue;
      if (!byFolder.has(part.folder)) byFolder.set(part.folder, new Map());
      byFolder.get(part.folder).set(part.name, object);
    }
  }
  return byFolder;
}

const emptyRow = () => ({ count: 0, bytes: 0 });
const add = (row, object) => {
  row.count++;
  row.bytes += object.size;
};
const sizeText = (bytes) =>
  bytes === 0
    ? '0 B'
    : bytes >= 1024 ** 3
      ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
      : bytes >= 1024 ** 2
        ? `${(bytes / 1024 ** 2).toFixed(1)} MiB`
        : `${(bytes / 1024).toFixed(1)} KiB`;

/**
 * The difference between the two inventories, per folder: what the target lacks, what it holds with other
 * contents (by size or by the ETag, which is the MD5 of an object written in one part), and what it holds
 * that the source does not. Objects written in parts carry an ETag that is not a checksum of the contents;
 * `sameContent` settles those by the sha256 the corpus proxy stores beside every object.
 */
async function compare(src, dst, sameContent) {
  const folders = [...new Set([...src.keys(), ...dst.keys()])].sort();
  const rows = [];
  for (const folder of folders) {
    const a = src.get(folder) ?? new Map();
    const b = dst.get(folder) ?? new Map();
    const row = {
      folder,
      source: emptyRow(),
      target: emptyRow(),
      missing: [],
      different: [],
      extra: [],
    };
    for (const object of a.values()) add(row.source, object);
    for (const object of b.values()) add(row.target, object);
    for (const [name, object] of [...a].sort(([x], [y]) => (x < y ? -1 : 1))) {
      const there = b.get(name);
      if (!there) row.missing.push(object);
      else if (!(await sameContent(object, there))) row.different.push(object);
    }
    for (const [name, object] of b) if (!a.has(name)) row.extra.push(object);
    rows.push(row);
  }
  return rows;
}

const bytesOf = (objects) => objects.reduce((n, o) => n + o.size, 0);
/** One digest of a folder's listing — names, sizes, ETags — to set beside a later listing of the same. */
const fingerprint = (objects) =>
  sha256(
    [...objects]
      .map(([name, o]) => `${name}\t${o.size}\t${o.etag}\n`)
      .sort()
      .join(''),
  ).slice(0, 16);

function parseArgs(argv) {
  const [first, ...rest] = argv;
  const action = first && !first.startsWith('-') ? first : 'plan';
  const flags = first && !first.startsWith('-') ? rest : argv;
  const known = new Set([
    '--from',
    '--to',
    '--folders',
    '--concurrency',
    '--overwrite-different',
    '--production',
    '--sample',
    '--deep',
    '--allow-extra',
    '--max-lines',
  ]);
  const valued = new Set([
    '--from',
    '--to',
    '--folders',
    '--concurrency',
    '--sample',
    '--max-lines',
  ]);
  const options = {};
  for (let i = 0; i < flags.length; i++) {
    const name = flags[i];
    if (!known.has(name)) throw new Fatal(`unknown argument ${name}`);
    if (valued.has(name)) {
      const value = flags[++i];
      if (value === undefined || value.startsWith('--')) throw new Fatal(`${name} needs a value`);
      options[name.slice(2)] = value;
    } else options[name.slice(2)] = true;
  }
  if (!['plan', 'copy', 'verify'].includes(action)) throw new Fatal(`unknown action ${action}`);
  return { action, options };
}

const integer = (value, fallback, min, max, name) => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Fatal(`${name} must be a whole number from ${min} to ${max}`);
  return n;
};

export const USAGE =
  'usage: corpus-transfer.mjs plan|copy|verify --from <bucket> --to <bucket> [--folders a,b] ' +
  '[--concurrency 1–64] [--overwrite-different] [--production] [--sample n | --deep] [--allow-extra] [--max-lines n]';

/**
 * The command over an injected client (see r2Client) and log. Answers the exit code: 0 done / matched,
 * 1 a difference (verify) or a stopped copy, 2 a refusal before anything was read.
 */
export async function runTransfer(argv, { client, log = console.log, random = Math.random }) {
  let action;
  let options;
  let folders;
  let concurrency;
  let sample;
  let maxLines;
  try {
    ({ action, options } = parseArgs(argv));
    if (!options.from || !options.to) throw new Fatal('--from and --to are both required');
    for (const bucket of [options.from, options.to])
      if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))
        throw new Fatal(`not a bucket name: ${bucket}`);
    if (options.from === options.to)
      throw new Fatal('the source and the target are the same bucket');
    if (action === 'copy' && options.to === PRODUCTION_BUCKET && !options.production)
      throw new Fatal(
        `${PRODUCTION_BUCKET} is the production bucket: a person copies into it, with --production`,
      );
    folders = options.folders?.split(',').map((f) => safeFolder(f.trim()));
    concurrency = integer(options.concurrency, 32, 1, 64, '--concurrency');
    sample = options.deep ? Infinity : integer(options.sample, 200, 0, 1_000_000, '--sample');
    maxLines = integer(options['max-lines'], 20, 1, 100_000, '--max-lines');
  } catch (error) {
    if (!(error instanceof Fatal || /^unsafe folder/.test(error.message))) throw error;
    log(`refused: ${error.message}`);
    log(USAGE);
    return 2;
  }
  const { from, to } = options;
  try {
    log(
      `${action}: ${from} → ${to}, corpus only (${CORPUS_PREFIX}<folder>/…)${folders ? `, folders ${folders.join(', ')}` : ''}`,
    );
    const [src, dst] = await Promise.all([
      inventory(client, from, folders),
      inventory(client, to, folders),
    ]);
    // Content settled by the stored sha256 only where the ETag cannot say (objects written in parts).
    const checked = [];
    const sameContent = async (a, b) => {
      if (a.size !== b.size) return false;
      if (!a.etag.includes('-') && !b.etag.includes('-')) return a.etag === b.etag;
      const [x, y] = await Promise.all([client.head(from, a.key), client.head(to, b.key)]);
      checked.push(a.key);
      return Boolean(x?.sha256 && x.sha256 === y?.sha256);
    };
    const rows = await compare(src, dst, sameContent);
    const total = (pick) => rows.reduce((n, r) => n + pick(r), 0);
    const listed = (label, objects) => {
      const shown = objects.slice(0, maxLines);
      for (const o of shown) log(`  ${label} ${o.key}`);
      if (objects.length > shown.length)
        log(`  … and ${objects.length - shown.length} more ${label}`);
    };

    if (action === 'plan' || action === 'copy') {
      for (const r of rows)
        log(
          `${r.folder}: source ${r.source.count} (${sizeText(r.source.bytes)}), target ${r.target.count}; ` +
            `missing ${r.missing.length} (${sizeText(bytesOf(r.missing))}), different ${r.different.length}, ` +
            `only in target ${r.extra.length}`,
        );
      const missing = rows.flatMap((r) => r.missing);
      const different = rows.flatMap((r) => r.different);
      log(
        `total: source ${total((r) => r.source.count)} objects (${sizeText(total((r) => r.source.bytes))}); ` +
          `to copy ${missing.length} (${sizeText(bytesOf(missing))}); different ${different.length}; ` +
          `only in target ${total((r) => r.extra.length)} (never deleted)`,
      );
      listed('different', different);
      if (action === 'plan') return 0;

      const work = [...missing];
      if (different.length && options['overwrite-different']) work.push(...different);
      else if (different.length)
        log(
          `${different.length} different objects are left as they are; --overwrite-different replaces them with the source's`,
        );
      // A folder's receipt goes last. The crawler takes a receipt that matches the folder's list without
      // opening a single file, so a receipt that arrived before its files — and a copy stopped in between —
      // would leave a folder the next run skips and then cannot read. The receipts are copied only once
      // every other object this run had to copy is in.
      const receipt = (o) => o.key.endsWith(`/${RECEIPT}`);
      const files = work.filter((o) => !receipt(o));
      const receipts = work.filter(receipt);
      let done = 0;
      let doneBytes = 0;
      let stopped;
      const step = Math.max(1, Math.ceil(work.length / 20));
      const copyAll = async (objects) => {
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(concurrency, objects.length) }, async () => {
            while (!stopped && next < objects.length) {
              const object = objects[next++];
              try {
                await client.copy(from, to, object.key, object.etag);
              } catch (error) {
                stopped ??= error;
                return;
              }
              done++;
              doneBytes += object.size;
              if (done % step === 0 || done === work.length)
                log(`copied ${done}/${work.length} (${sizeText(doneBytes)})`);
            }
          }),
        );
      };
      await copyAll(files);
      if (!stopped) await copyAll(receipts);
      if (stopped) {
        if (!(stopped instanceof Fatal)) throw stopped;
        log(`stopped after ${done} of ${work.length}: ${stopped.message}`);
        if (done < files.length && receipts.length)
          log(
            `${receipts.length} folder receipts were held back: they follow once every file before them is in`,
          );
        log('what was copied stays; run copy again to carry on from there');
        return 1;
      }
      log(`copied ${done} objects (${sizeText(doneBytes)}); run verify to compare the two buckets`);
      return 0;
    }

    // verify: every folder by count, bytes and fingerprint; every key by size and contents.
    let clean = true;
    for (const r of rows) {
      const a = src.get(r.folder) ?? new Map();
      const b = dst.get(r.folder) ?? new Map();
      const extra = options['allow-extra'] ? [] : r.extra;
      const same = !r.missing.length && !r.different.length && !extra.length;
      clean &&= same;
      log(
        `${same ? 'ok      ' : 'DIFFERS '}${r.folder}: count ${r.source.count}/${r.target.count}, ` +
          `bytes ${r.source.bytes}/${r.target.bytes}, fingerprint ${fingerprint(a)}/${fingerprint(b)}` +
          (same ? (r.extra.length ? ` (${r.extra.length} only in target, allowed)` : '') : ''),
      );
    }
    listed(
      'missing',
      rows.flatMap((r) => r.missing),
    );
    listed(
      'different',
      rows.flatMap((r) => r.different),
    );
    if (!options['allow-extra'])
      listed(
        'only-in-target',
        rows.flatMap((r) => r.extra),
      );

    // The listing cannot show the metadata: a sample (or all, --deep) of the matched objects is read
    // head to head for the sha256 the corpus reader checks every body against, and the content type.
    // Objects already named as different are not read again.
    const matched = rows.flatMap((r) => {
      const b = dst.get(r.folder) ?? new Map();
      const differs = new Set(r.different);
      return [...(src.get(r.folder) ?? new Map())]
        .filter(([name, o]) => b.has(name) && !differs.has(o))
        .map(([, o]) => o);
    });
    for (let i = matched.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [matched[i], matched[j]] = [matched[j], matched[i]];
    }
    const heads = matched.slice(0, Math.min(sample, matched.length));
    const metaDiffers = [];
    let at = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, heads.length) }, async () => {
        while (at < heads.length) {
          const object = heads[at++];
          const [x, y] = await Promise.all([
            client.head(from, object.key),
            client.head(to, object.key),
          ]);
          if (!x || !y || x.sha256 !== y.sha256 || x.contentType !== y.contentType)
            metaDiffers.push(object);
        }
      }),
    );
    log(
      `metadata: ${heads.length} of ${matched.length} matched objects read head to head, ${metaDiffers.length} differ`,
    );
    listed('metadata-differs', metaDiffers);
    if (checked.length)
      log(`${checked.length} objects written in parts were compared by their stored sha256`);
    clean &&= metaDiffers.length === 0;
    log(
      clean
        ? 'verify: the target holds the source corpus exactly'
        : 'verify: DIFFERENCES — see above',
    );
    return clean ? 0 : 1;
  } catch (error) {
    if (!(error instanceof Fatal)) throw error;
    log(`failed: ${error.message}`);
    return 1;
  }
}

async function main() {
  let client;
  try {
    client = r2Client(await resolveCredentials(process.env));
  } catch (error) {
    if (!(error instanceof Fatal)) throw error;
    console.error(`refused: ${error.message}`);
    return 2;
  }
  return runTransfer(process.argv.slice(2), { client });
}

if (import.meta.main) process.exitCode = await main();
