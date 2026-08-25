// HTTP client for the Търговски регистър public API (issue #279, ADR-0033).
//
// TLS: PLAIN HTTPS, verified against the system roots at Node's secure default. Do NOT reach for
// scripts/cacbg/tls.mjs here. That module exists because register.cacbg.bg serves an incomplete chain,
// so we pin ITS leaf key (ADR-0011) — `getPinned` hard-refuses every other host by design. This host
// chains correctly, so ordinary verification is available and is strictly stronger than a pin we would
// have to hand-maintain. Copying the pinning across "for consistency" would weaken this leg.
//
// Rate limiting (re-measured 2026-08-19 through this module's own httpsGet — ADR-0036, which supersedes
// ADR-0033's context 4). The budget is FIVE requests: the 6th returns 429. The block is scoped to the
// IP, not the session — a brand-new EPZEUSessionID is refused just the same, so carrying cookies does
// not help. There is no `Retry-After` and no `X-RateLimit-*`, the body is empty, and it comes back in
// 48-67ms against 250-475ms for a real deed, so it is refused at an edge before the application. It has
// a second face: while blocked, the connection may STALL (a 20s timeout) instead of answering 429.
// It clears on its own in ~161s.
//
// So a 429 is a COOLDOWN, not the sustained wall ADR-0033 recorded. This module still does not retry
// one — it reports the fact as `RateLimitError` and lets the caller decide, which is why the retry set
// here excludes 429 exactly as before. The wait-and-resume policy lives in fetch-deeds.mjs, because
// „how long to wait" is a crawl decision, not a transport one. `politeTrGet` retries 5xx and network
// faults with growing backoff, and never retries a 429.
//
// The pace floor does not move. The limiter is the operator's only way to express a rate preference,
// and probing its threshold empirically is what spec §3.3's "NEVER bulk-scrape" forbids — ADR-0036
// records one deliberate reproduction and sanctions no more.

import https from 'node:https';
import { safeEik } from './paths.mjs';

export const TR_HOST = 'portal.registryagency.bg';

// Identify the crawler honestly. The operator's only lever on us is the rate limiter, so at minimum
// they should be able to see who is calling and where to complain.
export const TR_USER_AGENT =
  'sigma-bot/1.0 (+https://github.com/midt-bg/sigma) contact: via repo issues';

/**
 * Thrown on HTTP 429. Distinguishable so the crawler can cool down and resume the SAME ЕИК without
 * marking anything about it — the block is a fact about us, never about that company (ADR-0036).
 */
export class RateLimitError extends Error {
  constructor(url) {
    super(`RATE LIMITED: ${TR_HOST} returned 429 for ${url} — cool down before the next request`);
    this.name = 'RateLimitError';
    this.url = url;
  }
}

/** Refuse any URL that is not an https request to the register. Call before touching the network. */
export function assertTrHost(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error(`bad URL: ${url}`);
  }
  if (u.protocol !== 'https:' || u.hostname !== TR_HOST) {
    throw new Error(`refusing non-${TR_HOST} host: ${url}`);
  }
  return url;
}

/** The public deed endpoint for one ЕИК. Public JSON, no authentication. */
export function deedUrl(eik) {
  return `https://${TR_HOST}/CR/api/Deeds/${safeEik(eik)}`;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Default transport: `node:https`, system roots, secure defaults.
 *
 * NOT `fetch`. Measured against the live endpoint on 2026-08-05, the identical request returns
 * **HTTP 500 with an empty body via undici's fetch and HTTP 200 with the full 34,398-byte deed via
 * node:https** — same URL, same accept header, same user-agent. The server rejects something undici
 * adds to the wire (encoding negotiation / connection handling); it is not an auth or rate-limit
 * problem, and retrying only multiplies the failure. `scripts/cacbg/tls.mjs` is on node:https too, so
 * both crawl legs now share one transport primitive.
 *
 * `rejectUnauthorized` is left at its secure default and named here on purpose: the sibling CACBG
 * module deliberately does NOT verify against system roots (it pins a leaf instead, ADR-0011), so a
 * reader comparing the two needs to see that this leg takes the ordinary, stronger path.
 */
/**
 * Ceiling on a single response body. A measured deed is ~34 KB, so 8 MB is ~240× the real thing —
 * this bounds abuse, not the register, and can never refuse a large-but-legitimate company.
 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Read one response into a Buffer, refusing past `maxBytes`.
 *
 * The timeout on the request bounds how long a response may STALL; nothing bounded how much it may
 * SEND. Without a counter the crawler buffers whatever arrives, so a wedged or hostile endpoint decides
 * how much memory this process holds. It also composes badly with the parser: the erasure regex in
 * deed.mjs backtracks quadratically on unclosed markup (measured 34K→3.7ms, 68K→13.5ms, 136K→53.2ms,
 * 272K→215.4ms — ×4 per doubling), and that path is reachable only through a body large enough to make
 * it matter. One byte counter bounds both, and destroying the request is the load-bearing half: merely
 * rejecting the promise would leave the socket draining the rest of the response.
 *
 * Separated from `httpsGet` so it is testable without TLS or a live socket — `res` needs only to be an
 * emitter of 'data'/'end'/'error', which is the same injection posture as politeTrGet's `httpGet`.
 */
export function collectBody(res, { req, maxBytes = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      req?.destroy(err); // tear the socket down; do not sit and drain what we already refused
      reject(err);
    };
    res.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        fail(new Error(`response too large: over ${maxBytes} bytes — refusing to buffer it`));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => {
      if (done) return;
      done = true;
      resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
    });
    res.on('error', fail);
  });
}

export function httpsGet(url, { timeoutMs = 20_000, maxBytes = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { accept: 'application/json', 'user-agent': TR_USER_AGENT } },
      (res) => collectBody(res, { req, maxBytes }).then(resolve, reject),
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms: ${url}`)));
    req.on('error', reject);
  });
}

/**
 * GET with polite retries. 5xx and network faults retry with growing backoff; 2xx/4xx return as-is;
 * **429 throws `RateLimitError` immediately and is never retried HERE** — waiting out the cooldown is
 * the crawler's call, not the transport's (ADR-0036).
 * @param {string} url
 * @param {{httpGet?:Function, sleep?:Function, tries?:number, backoffMs?:number}} [opts]
 *   `httpGet` and `sleep` are the injection seam — the whole retry policy is testable offline.
 */
export async function politeTrGet(url, opts = {}) {
  const { httpGet = httpsGet, sleep = wait, tries = 5, backoffMs = 1000 } = opts;
  assertTrHost(url); // before any request — a foreign host must cost zero packets
  let backoff = backoffMs;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await httpGet(url);
    } catch (err) {
      if (attempt >= tries) throw err;
      await sleep(backoff);
      backoff *= 2;
      continue;
    }
    // Checked before the retry branch: a 429 arriving mid-retry must abort the whole call, not be
    // folded into the 5xx budget and not let a later 200 mask the block. The caller cools down and
    // re-enters; retrying inside the 5xx budget would spend four more requests into a live block.
    if (res.status === 429) throw new RateLimitError(url);
    if (res.status >= 500) {
      if (attempt >= tries) return res; // give the caller the last response to record
      await sleep(backoff);
      backoff *= 2;
      continue;
    }
    return res;
  }
}

/** One deed by ЕИК. Thin wrapper so callers never build the URL themselves. */
export function trGet(eik, opts) {
  return politeTrGet(deedUrl(eik), opts);
}
