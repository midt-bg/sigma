// F1 — Report dedup (L0–L3) with a composite freshness token.
//
// The assistant is stateless and reports are immutable, public R2 artifacts at /reports/:id.
// Dedup here is not merely a cost optimisation: keying on the *resolved query* (L2) and the
// *result data* (L2.5) is what guarantees two people asking the same fixed-period question can
// never see different numbers. See docs/spec/ai-assistant-dedup.md.
//
// Master invariant (fail toward regeneration): a cache entry is valid iff its embedded freshness
// token equals the current one. Any doubt — missing/mismatched token, KV or parse error — is a
// miss, never a stale serve. `lookup`/`resolveReport` therefore swallow every error into `null`.
// `record` is best-effort and may reject; the request path should treat it as fire-and-forget
// (e.g. via ctx.waitUntil), mirroring workers/request-log.ts.
//
// Caller contract (trust boundary is upstream, not here): this module hashes whatever it is given
// and references — but never mints — a `reportId`. The orchestrator MUST validate/bound its inputs
// (prompt length, clientRequestId format) before calling, and MUST mint `reportId` server-side as an
// unguessable ≥128-bit value. A request-derived id would let a caller pre-seed another's cache key.

export type DedupLayer = 'L0' | 'L1' | 'L2' | 'L2.5' | 'L3';

/**
 * Minimal structural view of a Cloudflare KV namespace — only the methods this module uses.
 * A real `KVNamespace` is assignable to it, and tests can supply an in-memory fake without
 * pulling in the generated Worker types.
 */
export interface DedupKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface FreshnessInput {
  /** `home_totals.refreshed_at` — the ETL data version (see csv-export.ts). */
  refreshedAt: string;
  /** Build/config version — busts cache when CPV taxonomy / FX logic / report shape ship. */
  buildId: string;
}

/** Per-layer payloads. Only L1–L3 fold the freshness token into the key (see `dedupKey`). */
export type DedupPayload =
  | { layer: 'L0'; clientRequestId: string }
  | { layer: 'L1'; prompt: string; filterContext: string }
  | { layer: 'L2'; sql: string; params: readonly unknown[] }
  | { layer: 'L2.5'; resultFingerprint: string }
  | { layer: 'L3'; toolName: string; args: unknown };

interface StoredEntry {
  reportId: string;
  freshness: string;
  /** ISO-8601 generation time of the referenced report. */
  createdAt: string;
}

export interface DedupHit {
  reportId: string;
  createdAt: string;
  layer: DedupLayer;
}

/** Signals available to `resolveReport`; layers are attempted only when their inputs are present. */
export interface ResolveSignals {
  clientRequestId?: string;
  prompt?: string;
  filterContext?: string;
  sql?: string;
  params?: readonly unknown[];
  resultFingerprint?: string;
}

/** Default KV TTLs (seconds). Freshness is the real invalidator; TTL is a GC backstop. */
export const DEFAULT_TTL_SECONDS: Record<DedupLayer, number> = {
  L0: 86_400, // 24h — idempotency window for a single submission
  L1: 604_800, // 7d
  L2: 604_800, // 7d
  'L2.5': 604_800, // 7d
  L3: 600, // 10m — tool memo
};

const KEY_PREFIX = 'dedup';

// ── Freshness ────────────────────────────────────────────────────────────────

/**
 * Composite token `d:<data>|c:<code>`. The data half reuses the exact derivation csv-export.ts
 * already applies to `home_totals.refreshed_at` so the two caches invalidate in lockstep. Stripping
 * to `[a-z0-9]` is injective over the fixed-format inputs it receives (ISO-8601 timestamp, alphanumeric
 * build id) and keeps the `|` / `d:` / `c:` delimiters uninjectable.
 */
export function freshnessToken({ refreshedAt, buildId }: FreshnessInput): string {
  const data = refreshedAt.replace(/[^a-z0-9]/gi, '');
  const code = buildId.replace(/[^a-z0-9]/gi, '');
  return `d:${data}|c:${code}`;
}

// ── Canonical encoding (vendored from Lane E's length-prefix pattern) ─────────
//
// Deliberately vendored rather than imported: Lane E (PR #3) is not yet merged into this base, and a
// cross-PR import would couple this PR to its merge order. Consolidates onto Lane E's helper once #3
// lands (see docs/spec/ai-assistant-dedup.md §5).

const textEncoder = new TextEncoder();

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

/**
 * Length-prefixed, domain-separated field encoding — generalised from
 * transcript-hmac.ts's `canonicalBytes` (which is typed to TranscriptMessage). The 4-byte big-endian
 * length before every field makes the encoding injective, so distinct field tuples can never collide
 * after concatenation (e.g. ['ab','c'] and ['a','bc'] encode differently).
 */
export function encodeFields(domain: string, fields: readonly string[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const domainBytes = textEncoder.encode(domain);
  chunks.push(u32be(domainBytes.length), domainBytes, u32be(fields.length));
  for (const field of fields) {
    const bytes = textEncoder.encode(field);
    chunks.push(u32be(bytes.length), bytes);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // `bytes` is always backed by a fresh, non-shared ArrayBuffer (encodeFields / TextEncoder);
  // the BufferSource cast mirrors transcript-hmac.ts under TS's split Uint8Array<ArrayBufferLike> typing.
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

/**
 * Stable, injective serialisation for hashing: object keys are sorted recursively so key order
 * never affects the hash, and every distinct value within its documented domain (below) maps to a
 * distinct string. Out-of-domain exotics (Map/Set/Symbol/function) are not distinguished — but
 * cannot reach here (see domain note), so they are a non-goal, not a gap.
 *
 * `JSON.stringify` alone is NOT injective over JS values — it collapses `Date`→`{}`, `NaN`/`±Infinity`
 * →`null`, `undefined`→`null`, `-0`→`0`, and throws on `bigint`. Those six are tagged explicitly below,
 * because a collision here is the one failure this cache must never make: serving one question's numbers
 * for another (#97). Tags are unquoted, so they can never alias a real string value (which
 * `JSON.stringify` always quotes) nor each other.
 *
 * Domain: JSON values — from D1 bind params, D1 result rows, and JSON tool-call args — plus `Date`;
 * acyclic by construction (parsed JSON and D1 rows cannot contain cycles), so the recursion is bounded.
 * Non-JSON exotics (Map/Set/Symbol/function) cannot cross those boundaries, so they are out of scope.
 */
function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return `bigint:${value}`;
  if (value === undefined) return 'undefined';
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (typeof value === 'number' && !Number.isFinite(value)) return `number:${value}`; // NaN, ±Infinity
  if (Object.is(value, -0)) return 'number:-0'; // JSON.stringify erases the sign (-0 → "0")
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

/** NFC-normalise, collapse internal whitespace, trim. Case is preserved (Cyrillic-meaning safe). */
function normalizeText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

// ── Keys ─────────────────────────────────────────────────────────────────────

function canonicalFields(payload: DedupPayload, freshness: string): string[] {
  switch (payload.layer) {
    // L0 is request identity — freshness is validated against the stored entry, not folded in here,
    // so the same submission resolves to its report until the data underneath changes.
    case 'L0':
      return [payload.clientRequestId];
    case 'L1':
      return [normalizeText(payload.prompt), normalizeText(payload.filterContext), freshness];
    case 'L2':
      return [normalizeText(payload.sql), canonicalJson(payload.params), freshness];
    case 'L2.5':
      return [payload.resultFingerprint, freshness];
    case 'L3':
      return [payload.toolName, canonicalJson(payload.args), freshness];
  }
}

/** Deterministic KV key: `dedup:<layer>:<sha256>`. */
export async function dedupKey(payload: DedupPayload, freshness: string): Promise<string> {
  const fields = canonicalFields(payload, freshness);
  const hash = await sha256Hex(encodeFields(payload.layer, fields));
  return `${KEY_PREFIX}:${payload.layer}:${hash}`;
}

/**
 * Order-sensitive fingerprint of result rows for L2.5. Row order is preserved because it is
 * semantically meaningful (ranked reports); only each row's keys are canonicalised. Two queries
 * dedup via L2.5 only when they yield the *same rows in the same order* — never serving a report
 * ordered differently from what was asked.
 */
export async function resultFingerprint(rows: readonly Record<string, unknown>[]): Promise<string> {
  // Length-prefixed via encodeFields (same injective framing as dedupKey) so the row boundary is
  // self-delimiting by construction — not by trusting a separator to never appear inside a row.
  return sha256Hex(encodeFields('L2.5-rows', rows.map(canonicalJson)));
}

// ── Store / read ──────────────────────────────────────────────────────────────

function parseEntry(raw: string): StoredEntry | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredEntry>;
    if (
      parsed &&
      typeof parsed.reportId === 'string' &&
      typeof parsed.freshness === 'string' &&
      typeof parsed.createdAt === 'string'
    ) {
      return {
        reportId: parsed.reportId,
        freshness: parsed.freshness,
        createdAt: parsed.createdAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Look up one layer. Returns a hit only when the entry exists, parses, and its freshness matches
 * the current token. Any error (KV failure, malformed value, stale token) yields `null` —
 * fail toward regeneration.
 */
export async function lookup(
  kv: DedupKv,
  payload: DedupPayload,
  freshness: string,
): Promise<DedupHit | null> {
  try {
    const key = await dedupKey(payload, freshness);
    const raw = await kv.get(key);
    if (raw === null) return null;
    const entry = parseEntry(raw);
    if (!entry || entry.freshness !== freshness) return null;
    return { reportId: entry.reportId, createdAt: entry.createdAt, layer: payload.layer };
  } catch {
    return null;
  }
}

/**
 * Record a report under one layer's key. Best-effort: may reject if KV is unavailable; callers
 * should treat it as fire-and-forget. A lost write simply causes a future miss (regeneration).
 */
export async function record(
  kv: DedupKv,
  payload: DedupPayload,
  freshness: string,
  report: { reportId: string; createdAt: string },
  ttlSeconds: number = DEFAULT_TTL_SECONDS[payload.layer],
): Promise<void> {
  const key = await dedupKey(payload, freshness);
  const entry: StoredEntry = {
    reportId: report.reportId,
    freshness,
    createdAt: report.createdAt,
  };
  await kv.put(key, JSON.stringify(entry), { expirationTtl: ttlSeconds });
}

/**
 * Resolve a report by trying each layer whose signals are present, in escalating strength:
 * L0 (idempotency) → L1 (prompt) → L2 (resolved SQL) → L2.5 (result data). First valid hit wins.
 * Safe to call both before generation (L0/L1/L2) and after the query runs (adds L2.5).
 *
 * L3 (tool-memo) is intentionally not resolved here — it is a within-run tool cache the tool layer
 * consults directly via `lookup`, not a report-level layer.
 */
export async function resolveReport(
  kv: DedupKv,
  signals: ResolveSignals,
  freshness: string,
): Promise<DedupHit | null> {
  const attempts: DedupPayload[] = [];
  if (signals.clientRequestId !== undefined) {
    attempts.push({ layer: 'L0', clientRequestId: signals.clientRequestId });
  }
  if (signals.prompt !== undefined && signals.filterContext !== undefined) {
    attempts.push({ layer: 'L1', prompt: signals.prompt, filterContext: signals.filterContext });
  }
  if (signals.sql !== undefined && signals.params !== undefined) {
    attempts.push({ layer: 'L2', sql: signals.sql, params: signals.params });
  }
  if (signals.resultFingerprint !== undefined) {
    attempts.push({ layer: 'L2.5', resultFingerprint: signals.resultFingerprint });
  }
  for (const payload of attempts) {
    const hit = await lookup(kv, payload, freshness);
    if (hit) return hit;
  }
  return null;
}
