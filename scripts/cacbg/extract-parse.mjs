// Reading one folder of the declarations corpus, and nothing else.
//
// `parseFolder` turns a folder's list.xml and declaration files into PARSE RECORDS: the listing's rows and,
// file by file in the order the index names them, either the parsed declaration with the fingerprint of its
// bytes or the reason the parser refused it. The records depend on the folder's files and on this code only —
// never on the register, the identity rules, the run, the clock or another folder. Everything that does
// depend on those (who the declarant is, which copy of a republished document is the first, the quarantine,
// the counters) is decided later, over the records, by extract.mjs.
//
// One record per line, in this order:
//   {"head":{folder,listHash}}
//   {"list":{category,institution,person,position,xmlFile,personLocator}}   — every listing row
//   {"doc":{file,sourceFolder?,fingerprint,d}} | {"error":{file,sourceFolder?,message}}
//   {"end":{rows,files,documents,errors}}                                     — last, always
import fs from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { parseList, parseDeclaration } from './parse.mjs';
import { corpusFiles, digest } from './corpus.mjs';
import { safeXmlFile } from './guard.mjs';

/** The files a folder is read from, in reading order: its index when it has one, else its directory. */
export async function folderFiles(store, folder, index) {
  const files = index
    ? index.files
    : [...(await store.files(folder)).keys()].sort().map((file) => ({ file }));
  return files.filter(({ file }) => file !== 'list.xml' && file.endsWith('.xml'));
}

/**
 * Parse one folder into a records file at `out`. Returns the counts of its `end` record, or null for a
 * local folder without a list.xml (skipped, as before). Storage failures throw; only a malformed
 * declaration becomes an `error` record.
 */
export async function parseFolder(store, { folder, index, out, onFile = () => {} }) {
  const list = await store.get(`${folder}/list.xml`);
  if (!list) {
    if (store.remote) throw Error(`Missing corpus list: ${folder}`);
    console.log(`  ${folder}: no list.xml, skip`);
    return null;
  }
  if (index && digest(list) !== index.listHash) throw Error(`Corpus list changed: ${folder}`);
  const listXml = list.toString('utf8');
  const rows = parseList(listXml);
  if (index) {
    const listed = new Set(rows.map((r) => r.xmlFile));
    const covered = [...index.files.map((f) => f.file), ...index.missing, ...(index.failed ?? [])];
    if (
      new Set(covered).size !== covered.length ||
      covered.length !== listed.size ||
      covered.some((f) => !listed.has(f))
    )
      throw Error(`Corpus inventory does not match list: ${folder}`);
  }
  const files = await folderFiles(store, folder, index);
  const stream = fs.createWriteStream(out);
  const write = async (record) => {
    if (!stream.write(JSON.stringify(record) + '\n')) await once(stream, 'drain');
  };
  const end = { rows: rows.length, files: 0, documents: 0, errors: 0 };
  try {
    // The listing's fingerprint is the document fingerprint of its text, as the source groups carry it.
    await write({ head: { folder, listHash: digest(listXml) } });
    for (const row of rows) await write({ list: row });
    for await (const { file, sha256, bytes, sourceFolder } of corpusFiles(store, folder, files)) {
      if (safeXmlFile(file) !== file) throw Error('Invalid corpus filename');
      if (!bytes || (store.remote && digest(bytes) !== sha256))
        throw Error(`Corpus file missing or changed: ${folder}/${file}`);
      onFile();
      end.files++;
      const xml = bytes.toString('utf8');
      let d;
      try {
        d = parseDeclaration(xml);
      } catch (err) {
        end.errors++;
        await write({
          error: { file, sourceFolder, message: `${err instanceof Error ? err.message : err}` },
        });
        continue;
      }
      end.documents++;
      // The fingerprint of the TEXT (source-identity.mjs documentFingerprint): only byte-identical
      // documents are one republished declaration.
      await write({ doc: { file, sourceFolder, fingerprint: digest(xml), d } });
    }
    await write({ end });
  } finally {
    stream.end();
    await finished(stream);
  }
  return end;
}

/** The records of a file `parseFolder` wrote, one object at a time. */
export async function* readRecords(file) {
  const lines = createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line);
}
