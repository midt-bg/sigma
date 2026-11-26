// The parse cache: one folder's parse records (extract-parse.mjs), kept in the corpus bucket beside the
// corpus and independent of any run.
//
// The records are a function of two things only — the folder's files and the parser — so the entry's key
// is made of exactly those two:
//
//   parse-cache/<parser version>/<folder>/<inputs>.jsonl.gz
//
// • <inputs> — sha256 of the folder's listing and of every file it reads, by name, by the folder it lives
//   in and by its CONTENT hash (the index's sha256, or the file's own bytes where a local index has none).
//   A file added, removed, renamed or changed, or a new listing, is a new key. Timestamps play no part.
// • <parser version> — derived from the parser itself, never written by hand: the source text of every
//   module the parse step reaches (extract-parse.mjs and its imports, followed through the import graph),
//   the exact versions of the packages they import (and theirs), the Node version that runs them (its
//   regular expressions, Date and zlib are part of the result) and FORMAT below. A change to any of them
//   moves every key at once. A version that cannot be forgotten costs a full parse after a comment edit;
//   a forgotten one would serve stale records for as long as nobody noticed.
//
// The entry is ONE object: a gzip of the records file, byte for byte. Writing it is one put — atomic in R2
// and a rename on disk — so two runs that write the same key at once each leave a whole entry, and both are
// the same records by construction (the same inputs through the same parser). Reading it is checked three
// ways: the store's sha256 of the object, gzip's own CRC and length, and the records' `end` line that must
// close them with the counts of what came before. An entry that fails any of them is not there; the folder
// is parsed again and the entry written anew.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { digest } from './corpus.mjs';
import { readRecords } from './extract-parse.mjs';

/** The layout of an entry: raise it when the records change shape without the parser's source doing so. */
export const FORMAT = 1;
const PARSER_ENTRY = fileURLToPath(new URL('./extract-parse.mjs', import.meta.url));

/** Every module the parse step reaches, as absolute paths, and every package it imports, by name. */
export function parserClosure(entry = PARSER_ENTRY) {
  const modules = new Set();
  const packages = new Map();
  const visit = (file) => {
    if (modules.has(file)) return;
    modules.add(file);
    const source = fs.readFileSync(file, 'utf8');
    // A dynamic import would hide a module from this walk; the parse step must not have one.
    if (/\bimport\s*\(/.test(source)) throw Error(`Dynamic import in the parse step: ${file}`);
    const specs = [
      ...source.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gms),
      ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
    ].map((m) => m[1]);
    for (const spec of specs) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) visit(path.resolve(path.dirname(file), spec));
      else addPackage(packageName(spec), path.dirname(file));
    }
  };
  const addPackage = (name, from) => {
    const dir = packageDir(name, from);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const id = `${name}@${manifest.version}`;
    if (packages.has(id)) return;
    packages.set(id, dir);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) addPackage(dependency, dir);
  };
  visit(entry);
  return { modules: [...modules].sort(), packages: [...packages.keys()].sort() };
}

const packageName = (spec) =>
  spec
    .split('/')
    .slice(0, spec.startsWith('@') ? 2 : 1)
    .join('/');
/** Node's own lookup for a package directory: node_modules/<name> in this directory or the nearest above. */
function packageDir(name, from) {
  for (let dir = fs.realpathSync(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) throw Error(`Package not found for the parse step: ${name}`);
  }
}

const versions = new Map();
/** The parser version: 16 hex characters of the hash described above. Modules are named relative to the
 *  entry's directory, so the same sources give the same version wherever the checkout lies. `node` and
 *  `format` are this process's Node and FORMAT; they are parameters only so that a test can move them. */
export function parserVersion(
  entry = PARSER_ENTRY,
  { node = process.version, format = FORMAT } = {},
) {
  const memo = JSON.stringify([entry, node, format]);
  if (versions.has(memo)) return versions.get(memo);
  const { modules, packages } = parserClosure(entry);
  const hash = createHash('sha256').update(`format ${format}\nnode ${node}\n`);
  for (const file of modules)
    hash.update(`${path.relative(path.dirname(entry), file)}\n`).update(fs.readFileSync(file));
  for (const id of packages) hash.update(`\n${id}`);
  versions.set(memo, hash.digest('hex').slice(0, 16));
  return versions.get(memo);
}

/** The inputs of one folder: its name, its listing's hash and each file it reads, in reading order. */
export function inputsKey(folder, listHash, files) {
  return digest(
    JSON.stringify({
      folder,
      listHash,
      files: files.map(({ file, sourceFolder, sha256 }) => [file, sourceFolder ?? folder, sha256]),
    }),
  );
}

/** The entry key of a folder, or null when the folder cannot be keyed (a local folder without list.xml). */
export async function entryKey(store, folder, index, files, version = parserVersion()) {
  let listHash = index?.listHash;
  if (!listHash) {
    const list = await store.get(`${folder}/list.xml`);
    if (!list) return null;
    listHash = digest(list);
  }
  const hashed = [];
  for (const entry of files) {
    // A local index carries no content hashes, so the bytes are read for the key; R2's always has them.
    let { sha256 } = entry;
    if (!sha256) {
      const bytes = await store.get(`${entry.sourceFolder ?? folder}/${entry.file}`);
      if (!bytes) return null;
      sha256 = digest(bytes);
    }
    hashed.push({ ...entry, sha256 });
  }
  return `parse-cache/${version}/${folder}/${inputsKey(folder, listHash, hashed)}.jsonl.gz`;
}

/** Fetch a stored object to a file without holding it in memory; false when it is not there. */
async function download(store, key, file) {
  if (store.download) return store.download(key, file);
  const body = await store.get(key);
  if (!body) return false;
  fs.writeFileSync(file, body);
  return true;
}

/** Are these whole records: a head, the end line last, and the end's counts true to the lines before it? */
async function checkRecords(file, folder) {
  const seen = { rows: 0, files: 0, documents: 0, errors: 0 };
  let head;
  let end;
  for await (const record of readRecords(file)) {
    if (end) throw Error('records go on after their end');
    if (record.head) head = record.head;
    else if (record.list) seen.rows++;
    else if (record.doc) (seen.files++, seen.documents++);
    else if (record.error) (seen.files++, seen.errors++);
    else if (record.end) end = record.end;
    else throw Error('unknown record');
  }
  if (head?.folder !== folder) throw Error('records of another folder');
  if (!end) throw Error('records without an end');
  for (const [count, n] of Object.entries(seen))
    if (end[count] !== n) throw Error(`the end counts ${end[count]} ${count}, the records ${n}`);
  return end;
}

const rethrow = (error) => {
  throw error;
};

/**
 * Restore a folder's records from the cache into `out`. Returns the records' `end` counts, or null when
 * there is no usable entry: absent, or failing a check (`onUnusable` hears why). Streams throughout: the
 * entry goes to disk, then through gunzip into `out`. A renewal that cannot be written goes to
 * `onWriteFailed`; the records restored are whole either way.
 */
export async function restoreEntry(
  store,
  { key, folder, out, onUnusable = () => {}, onWriteFailed = rethrow },
) {
  const gz = `${out}.gz`;
  try {
    let end;
    try {
      if (!(await download(store, key, gz))) return null;
      await pipeline(fs.createReadStream(gz), createGunzip(), fs.createWriteStream(out));
      end = await checkRecords(out, folder);
    } catch (error) {
      // A cut or damaged object is no entry; nothing of it is used.
      onUnusable(error);
      fs.rmSync(out, { force: true });
      return null;
    }
    // An entry is renewed each time a run uses it, so the bucket's expiry only ever takes an entry no run
    // has used for the whole expiry period (docs/deploy.md). One put of the same bytes.
    if (store.remote) {
      try {
        await store.put(key, fs.readFileSync(gz));
      } catch (error) {
        onWriteFailed(error);
      }
    }
    return end;
  } finally {
    fs.rmSync(gz, { force: true });
  }
}

/**
 * Keep a folder's freshly parsed records under `key`: compressed on disk first, then one put. A write
 * that fails goes to `onWriteFailed`, and `records` stay as they are: the cache only saves the next run
 * a parse, so a run that cannot write it carries on, and the next run parses the folder again.
 */
export async function saveEntry(store, { key, records, onWriteFailed = rethrow }) {
  const gz = `${records}.gz`;
  try {
    await pipeline(fs.createReadStream(records), createGzip(), fs.createWriteStream(gz));
    await store.put(key, fs.readFileSync(gz));
  } catch (error) {
    onWriteFailed(error);
  } finally {
    fs.rmSync(gz, { force: true });
  }
}
