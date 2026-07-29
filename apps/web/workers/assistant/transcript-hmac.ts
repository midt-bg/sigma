// E1 — HMAC transcript signing (anti-injection).
//
// The assistant is stateless: every turn the browser POSTs the prior transcript back to the
// server, so any `assistant`/`tool` message the model re-reads is attacker-controlled. To make a
// server-emitted message provable on the next turn, we HMAC-sign the tuple
// (role, content, conversationId, turnIndex, position, report-chips) — binding the content to its
// conversation, exact slot, and any /reports/:id chips it carries so it cannot be forged, replayed
// across conversations, duplicated, reordered, or have its report chips retitled or re-pointed at
// another report (the credibility-laundering vector the spec flags as the top threat).
// `user` messages are unsigned by definition (the user authors them; the model never treats them
// as authoritative). Crypto mechanics mirror apps/web/workers/request-log.ts.

export type AssistantRole = 'user' | 'assistant' | 'tool';

export interface TranscriptMessage {
  role: AssistantRole;
  content: string;
  conversationId: string;
  /** 0-based turn index within the conversation. */
  turnIndex: number;
  /** 0-based position of this message within its turn. */
  position: number;
  /** Lowercase hex HMAC-SHA-256 over the signed tuple; absent on user / unsigned messages. */
  sig?: string;
  /**
   * Report chips the message references. Bound into the signature (each ref's id + title) so a chip
   * on a verbatim message cannot be retitled or re-pointed at another `/reports/:id` on a later
   * turn. This deliberately extends the spec's base tuple
   * (role/content/conversationId/turnIndex/position) as defense-in-depth against credibility
   * laundering; the trim summary additionally folds chips into its signed `content`.
   */
  reports?: readonly ReportRef[];
}

export interface ReportRef {
  id: string;
  title: string;
}

export interface AssistantHmacEnv {
  ASSISTANT_HMAC_KEY?: string;
  /**
   * The immediately-prior signing key, set ONLY during a rotation window (ADR-0012 §6). Signing always
   * uses the current key; verification accepts EITHER key, so messages signed under the old key stay
   * valid until the window closes and this is unset. Absent outside a rotation.
   */
  ASSISTANT_HMAC_KEY_PREVIOUS?: string;
}

export type DropReason =
  | 'unsigned'
  | 'malformed-slot'
  | 'invalid-signature'
  | 'wrong-conversation'
  | 'replay'
  | 'out-of-position';

export interface DroppedMessage {
  message: TranscriptMessage;
  reason: DropReason;
}

export interface FilterResult {
  kept: TranscriptMessage[];
  dropped: DroppedMessage[];
}

// Domain separation prefix — versioned so the wire format can evolve without silent collisions.
const SIGN_PREFIX = 'sigma-transcript-v1';

// Imported keys keyed by their raw material. A Map (not a single slot) so a rotation window — where
// sign uses the current key and verify may fall back to the previous one — doesn't thrash re-imports.
const keyCache = new Map<string, Promise<CryptoKey>>();

function keyMaterial(env: AssistantHmacEnv): string {
  const key = env.ASSISTANT_HMAC_KEY?.trim();
  if (!key) {
    throw new Error('ASSISTANT_HMAC_KEY is not configured; refusing to sign/verify transcript');
  }
  return key;
}

// The previous signing key during a rotation window, or null outside one / when it equals the current
// key (nothing extra to try).
function previousKeyMaterial(env: AssistantHmacEnv, current: string): string | null {
  const prev = env.ASSISTANT_HMAC_KEY_PREVIOUS?.trim();
  return prev && prev !== current ? prev : null;
}

function importedKey(material: string): Promise<CryptoKey> {
  let cached = keyCache.get(material);
  if (!cached) {
    cached = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(material),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    keyCache.set(material, cached);
  }
  return cached;
}

/**
 * Test seam: drop the module-level key cache so the next sign/verify re-imports its key. The cache
 * is keyed by material (rotation-safe in production), so this only matters for tests that swap
 * `ASSISTANT_HMAC_KEY` between cases and want to stay order-independent.
 */
export function resetKeyCache(): void {
  keyCache.clear();
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Unambiguous, length-prefixed canonical encoding of the signed tuple. Each field is written as a
// 4-byte big-endian UTF-8 byte length followed by its bytes, so no field value (e.g. a `content`
// containing a delimiter) can be crafted to impersonate a different tuple's serialization.
function canonicalBytes(msg: TranscriptMessage): Uint8Array {
  const encoder = new TextEncoder();
  const fields = [
    SIGN_PREFIX,
    msg.role,
    msg.content,
    msg.conversationId,
    integerField('turnIndex', msg.turnIndex),
    integerField('position', msg.position),
    // Report chips: a count, then each ref's id and title. A message with no chips signs identically
    // whether `reports` is absent or empty. Length-prefixing every field (below) keeps the encoding
    // unambiguous, so no chip id/title can be crafted to impersonate another field boundary.
    integerField('reports.length', (msg.reports ?? []).length),
  ];
  for (const ref of msg.reports ?? []) {
    fields.push(ref.id, ref.title);
  }
  const encoded = fields.map((field) => encoder.encode(field));
  const total = encoded.reduce((sum, bytes) => sum + 4 + bytes.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const bytes of encoded) {
    view.setUint32(offset, bytes.length, false);
    offset += 4;
    out.set(bytes, offset);
    offset += bytes.length;
  }
  return out;
}

function integerField(name: string, value: number): string {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${value}`);
  }
  return String(value);
}

// Slot fields are caller-supplied (untrusted on the verify/filter path). True only when both are
// non-negative integers — i.e. when canonical encoding will not throw. Lets verification reject
// malformed input gracefully instead of letting `integerField` throw out of a verify call.
function hasValidSlot(msg: TranscriptMessage): boolean {
  return (
    Number.isInteger(msg.turnIndex) &&
    msg.turnIndex >= 0 &&
    Number.isInteger(msg.position) &&
    msg.position >= 0 &&
    // `reports` is client-authored; a non-array value (e.g. a number) would make `(msg.reports ??
    // []).length` undefined and throw in canonicalBytes. Drop such a message rather than let the
    // uncaught throw fail the whole verify/filter pass.
    (msg.reports == null || Array.isArray(msg.reports))
  );
}

async function computeSignatureWith(material: string, msg: TranscriptMessage): Promise<string> {
  const key = await importedKey(material);
  const signature = await crypto.subtle.sign('HMAC', key, canonicalBytes(msg) as BufferSource);
  return hex(signature);
}

// Signing (and the fast path of verification) always uses the CURRENT key. `async` so an unset-key
// throw from `keyMaterial` surfaces as a rejected promise (fail closed), not a synchronous exception.
async function computeSignature(env: AssistantHmacEnv, msg: TranscriptMessage): Promise<string> {
  return computeSignatureWith(keyMaterial(env), msg);
}

// Length-aware constant-time comparison of two hex strings. Length is not secret here, but
// returning early on a length mismatch keeps the loop bound stable for equal-length inputs.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** HMAC-SHA-256 (hex) over (role, content, conversationId, turnIndex, position, report-chips). */
export function signMessage(env: AssistantHmacEnv, msg: TranscriptMessage): Promise<string> {
  return computeSignature(env, msg);
}

/** Return a copy of `msg` with its `sig` attached. */
export async function attachSignature(
  env: AssistantHmacEnv,
  msg: TranscriptMessage,
): Promise<TranscriptMessage> {
  const sig = await computeSignature(env, msg);
  return { ...msg, sig };
}

/**
 * Verify a message's `sig` against a freshly computed signature (constant-time). During a rotation
 * window the previous key is also accepted, so messages signed just before a key swap survive until
 * the window closes (ADR-0012 §6). Signing is unaffected — always the current key.
 */
export async function verifyMessage(
  env: AssistantHmacEnv,
  msg: TranscriptMessage,
): Promise<boolean> {
  if (!msg.sig) return false;
  if (!hasValidSlot(msg)) return false;
  const current = keyMaterial(env);
  if (constantTimeEqual(msg.sig, await computeSignatureWith(current, msg))) return true;
  const previous = previousKeyMaterial(env, current);
  if (!previous) return false;
  return constantTimeEqual(msg.sig, await computeSignatureWith(previous, msg));
}

function compareSlot(a: TranscriptMessage, b: TranscriptMessage): number {
  if (a.turnIndex !== b.turnIndex) return a.turnIndex - b.turnIndex;
  return a.position - b.position;
}

/**
 * Drop every `assistant`/`tool` message that is not a current, authentic, in-order server emission
 * for `conversationId`. `user` messages are always kept (untrusted input, never authoritative).
 * Each dropped message records why. Throws if the signing key is unconfigured (fail closed).
 */
export async function filterIncomingTranscript(
  env: AssistantHmacEnv,
  messages: readonly TranscriptMessage[],
  conversationId: string,
): Promise<FilterResult> {
  const kept: TranscriptMessage[] = [];
  const dropped: DroppedMessage[] = [];
  const seen = new Set<string>();
  let lastSlot: TranscriptMessage | null = null;

  for (const message of messages) {
    if (message.role === 'user') {
      kept.push(message);
      continue;
    }

    if (!message.sig) {
      dropped.push({ message, reason: 'unsigned' });
      continue;
    }
    if (!hasValidSlot(message)) {
      dropped.push({ message, reason: 'malformed-slot' });
      continue;
    }
    if (!(await verifyMessage(env, message))) {
      dropped.push({ message, reason: 'invalid-signature' });
      continue;
    }
    if (message.conversationId !== conversationId) {
      dropped.push({ message, reason: 'wrong-conversation' });
      continue;
    }
    const slotKey = `${message.turnIndex}:${message.position}`;
    if (seen.has(slotKey)) {
      dropped.push({ message, reason: 'replay' });
      continue;
    }
    if (lastSlot && compareSlot(message, lastSlot) <= 0) {
      dropped.push({ message, reason: 'out-of-position' });
      continue;
    }

    seen.add(slotKey);
    lastSlot = message;
    kept.push(message);
  }

  return { kept, dropped };
}

// Exposed for the trim module and tests that assert ordering semantics directly.
export { compareSlot };
