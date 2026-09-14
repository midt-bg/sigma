// The same crawler/parser reads local files or individual, checksummed R2 objects.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { safeFolder, safeXmlFile } from './guard.mjs';

export const CORPUS_STAMP = '.corpus-complete.json';
export const digest = (body) => createHash('sha256').update(body).digest('hex');

// Bounded batches hide R2 latency while preserving the parser's deterministic file order.
export async function* corpusFiles(store, folder, files, width = 16) {
  if (!Number.isInteger(width) || width < 1 || width > 32)
    throw Error('Invalid corpus read concurrency');
  for (let i = 0; i < files.length; i += width) {
    const batch = files.slice(i, i + width);
    const bodies = await Promise.all(
      batch.map(({ file }) => store.get(`${folder}/${safeXmlFile(file)}`)),
    );
    for (let j = 0; j < batch.length; j++) yield { ...batch[j], bytes: bodies[j] };
  }
}

function safeKey(key) {
  if ([CORPUS_STAMP, 'accepted.json'].includes(key)) return key;
  const parts = key.split('/');
  if (parts.length !== 2) throw Error('Invalid corpus key');
  safeFolder(parts[0]);
  if (parts[1] !== '.index.json') safeXmlFile(parts[1]);
  return key;
}

export function corpusStore(rawDir, endpoint = process.env.CACBG_CORPUS_URL, http = fetch) {
  if (!endpoint)
    return {
      remote: false,
      async get(key) {
        const p = path.join(rawDir, safeKey(key));
        return fs.existsSync(p) ? fs.readFileSync(p) : null;
      },
      async put(key, body) {
        const p = path.join(rawDir, safeKey(key));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(`${p}.tmp`, body);
        fs.renameSync(`${p}.tmp`, p);
      },
      async remove(key) {
        fs.rmSync(path.join(rawDir, safeKey(key)), { force: true });
      },
      async files(folder) {
        const dir = path.join(rawDir, safeFolder(folder));
        return new Map(
          (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.xml')) : []).map(
            (f) => [f, null],
          ),
        );
      },
    };
  // Native Container outbound interception, never a public raw-data endpoint.
  if (endpoint !== 'http://declarations.r2') throw Error('Invalid private corpus endpoint');
  async function request(key, options = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await http(`${endpoint}/${key}`, {
          ...options,
          redirect: 'error',
          signal: AbortSignal.timeout(60000),
        });
      } catch (error) {
        if (attempt === 4) throw error;
      }
      if (res && (res.ok || res.status === 404)) return res;
      if (res && res.status !== 429 && res.status < 500)
        throw Error(`Corpus ${options.method ?? 'GET'} failed: ${res.status}`);
      if (attempt === 4) throw Error(`Corpus request failed: ${res?.status ?? 'network'}`);
      await res?.body?.cancel();
      await sleep(500 * 2 ** attempt);
    }
  }
  return {
    remote: true,
    async get(key) {
      const res = await request(encodeURI(safeKey(key)));
      if (res.status === 404) return null;
      const body = Buffer.from(await res.arrayBuffer());
      if (res.headers.get('x-corpus-sha256') !== digest(body))
        throw Error(`Corpus checksum mismatch: ${key}`);
      return body;
    },
    async put(key, body) {
      const res = await request(encodeURI(safeKey(key)), {
        method: 'PUT',
        body,
        headers: {
          'x-corpus-sha256': digest(body),
          'content-type': key.endsWith('.xml') ? 'application/xml' : 'application/json',
        },
      });
      if (!res.ok) throw Error(`Corpus write failed: ${key}`);
      await res.body?.cancel();
    },
    async remove(key) {
      if (key !== CORPUS_STAMP) throw Error('Only the working corpus stamp can be removed');
      await request(key, { method: 'DELETE' });
    },
    async files(folder) {
      const files = new Map();
      let cursor = '';
      do {
        const query = new URLSearchParams({ prefix: `${safeFolder(folder)}/`, cursor });
        const res = await request(`?${query}`);
        if (!res.ok) throw Error('Corpus listing failed');
        const page = await res.json();
        for (const { key, sha256 } of page.objects) {
          safeKey(key);
          if (!key.startsWith(`${folder}/`)) throw Error('Corpus listing escaped folder');
          if (key.endsWith('.xml')) {
            if (!/^[a-f0-9]{64}$/.test(sha256 ?? ''))
              throw Error(`Missing corpus checksum: ${key}`);
            files.set(key.slice(folder.length + 1), sha256);
          }
        }
        if (page.truncated && (!page.cursor || page.cursor === cursor))
          throw Error('Corpus listing did not advance');
        cursor = page.truncated ? page.cursor : '';
      } while (cursor);
      return files;
    },
  };
}
