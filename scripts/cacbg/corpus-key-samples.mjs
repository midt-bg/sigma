// The corpus key allowlist lives twice — in the container's client (corpus.mjs `safeKey`) and in the
// Worker that serves it (apps/etl/src/declaration-corpus.ts `keyPattern`). These samples are the one
// place both are asserted from, so the two cannot drift apart.
const RUN = '00000000-0000-4000-8000-000000000000';
const FP = '0123456789abcdef';
export const ACCEPTED_KEYS = [
  '.corpus-complete.json',
  'accepted.json',
  `fetch-events/${RUN}/1.json`,
  '2025/a.xml',
  '2025/.index.json',
  `checkpoints/${RUN}/head.json`,
  `checkpoints/${RUN}/${FP}/2025/filings.jsonl.gz`,
  `checkpoints/${RUN}/${FP}/2025y/source-groups.jsonl.gz`,
];
export const REJECTED_KEYS = [
  'secret',
  '2025/a.txt',
  'fetch-events/invalid/1.json',
  'checkpoints/head.json',
  `checkpoints/${RUN}/2025/filings.jsonl.gz`, // no input fingerprint
  `checkpoints/${RUN}/${FP}/2025/backfill.sqlite.gz`, // not one of the six streams
  `checkpoints/${RUN}/${FP}/2025/filings.jsonl`, // must be the compressed part
];
// Traversal is asserted on the client only: a request URL has it normalized away before the Worker
// sees a path, so the proxy never receives these strings as keys.
export const REJECTED_TRAVERSAL_KEYS = [
  '../2025/a.xml',
  `checkpoints/${RUN}/${FP}/../filings.jsonl.gz`,
];
