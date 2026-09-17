// Cloudflare stops a container whenever it likes (SIGTERM, then SIGKILL), and its disk is ephemeral.
// The extraction of the whole corpus takes over an hour, so it commits what it has at every folder
// boundary: the folder's six output parts, then — LAST — the head that names the accepted folders.
// A part the head does not name simply does not exist for a resume, so a torn commit is invisible.
//
// The key carries a fingerprint of the INPUTS (corpus stamp, identity rules, registry facts). A
// forgotten container that wakes up and writes after the run moved on lands under a different
// fingerprint and can never be mixed into the new generation.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

/** The six append-only streams extract.mjs writes, in a fixed order. */
export const STREAMS = [
  'holdings',
  'related',
  'filings',
  'source-groups',
  'registry-requests',
  'source-quarantine',
];
const FOLDER = /^20\d{2}[A-Za-z0-9_]{0,8}$/;

export const checkpointFingerprint = (parts) =>
  createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
export const headKey = (runId) => `checkpoints/${runId}/head.json`;
export const partKey = (runId, fingerprint, folder, stream) =>
  `checkpoints/${runId}/${fingerprint}/${folder}/${stream}.jsonl.gz`;
export const partPath = (dir, folder, stream) => path.join(dir, `${folder}.${stream}.jsonl`);

/** The accepted checkpoint for this run, or null when there is none for these inputs. */
export async function readHead(store, runId, fingerprint) {
  const body = await store.get(headKey(runId));
  if (!body) return null;
  const head = JSON.parse(body.toString('utf8'));
  if (head.fingerprint !== fingerprint || !Array.isArray(head.folders)) return null;
  return head;
}

/** Accept one folder: its six parts first, the head last. Returns the new head. */
export async function commitFolder(
  store,
  { runId, fingerprint, dir, head, folder, stats, processed },
) {
  if (!FOLDER.test(folder)) throw Error(`Invalid checkpoint folder: ${folder}`);
  for (const stream of STREAMS) {
    const file = partPath(dir, folder, stream);
    await store.put(partKey(runId, fingerprint, folder, stream), gzipSync(fs.readFileSync(file)));
  }
  const next = { fingerprint, folders: [...head.folders, folder], stats, processed };
  await store.put(headKey(runId), Buffer.from(JSON.stringify(next)));
  return next;
}

/** Bring the accepted folders' parts back to disk. A missing part refuses the whole checkpoint. */
export async function restoreParts(store, { runId, fingerprint, dir, head, onFolder }) {
  fs.mkdirSync(dir, { recursive: true });
  for (const folder of head.folders) {
    for (const stream of STREAMS) {
      const body = await store.get(partKey(runId, fingerprint, folder, stream));
      if (!body) throw Error(`Checkpoint part missing: ${folder}/${stream}`);
      fs.writeFileSync(partPath(dir, folder, stream), gunzipSync(body));
    }
    onFolder?.(folder);
  }
}

/** The document-duplication map, rebuilt from the restored filings parts. Every entry of it is one
 * filings row (the row is written right after the entry is made), so nothing needs uploading. */
export function seenHashFrom(dir, folders) {
  const seen = new Map();
  for (const folder of folders)
    for (const line of fs.readFileSync(partPath(dir, folder, 'filings'), 'utf8').split('\n')) {
      if (!line) continue;
      const row = JSON.parse(line);
      seen.set(row.sourceHash, {
        sourceId: `cacbg:${row.folder}:${row.xmlFile}`,
        sourceHash: row.sourceHash,
      });
    }
  return seen;
}

/** The final six files are the parts concatenated in folder order — byte for byte what an
 * uninterrupted pass would have written. */
export function concatParts(dir, folders, target) {
  for (const stream of STREAMS) {
    const out = fs.openSync(target(stream), 'w');
    try {
      for (const folder of folders)
        fs.writeSync(out, fs.readFileSync(partPath(dir, folder, stream)));
    } finally {
      fs.closeSync(out);
    }
  }
}
