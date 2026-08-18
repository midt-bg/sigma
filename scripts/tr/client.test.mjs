// node:test — the Trade Register HTTP client. Offline: every test drives an injected getter.
//
// The load-bearing behaviour here is what the client REFUSES to do. The register rate-limits, and
// when it does the block is sustained (an earlier spike saw HTTP 429 at ~50 cumulative requests, then
// 429 to every subsequent call including ones that had just worked — no Retry-After, no quota header).
// So a 429 is an instruction to stop, not a transient to retry through. ADR-0033 decision 7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  TR_HOST,
  TR_USER_AGENT,
  deedUrl,
  RateLimitError,
  politeTrGet,
  assertTrHost,
  httpsGet,
  collectBody,
  MAX_BODY_BYTES,
} from './client.mjs';

const okRes = (body = '{}') => ({ status: 200, headers: {}, body: Buffer.from(body) });

test('deedUrl builds the documented endpoint and refuses a non-ЕИК', () => {
  assert.equal(deedUrl('115536179'), `https://${TR_HOST}/CR/api/Deeds/115536179`);
  assert.equal(deedUrl('000696327'), `https://${TR_HOST}/CR/api/Deeds/000696327`);
  for (const bad of ['', null, '../../etc', '115536179?x=1', '11553617x', 'ЕИК 115536179'])
    assert.throws(() => deedUrl(bad), /unsafe|ЕИК/i, String(bad));
});

test('assertTrHost refuses every host but the register', () => {
  assert.doesNotThrow(() => assertTrHost(`https://${TR_HOST}/CR/api/Deeds/115536179`));
  for (const bad of [
    'https://evil.example/CR/api/Deeds/115536179',
    `http://${TR_HOST}/CR/api/Deeds/115536179`, // plaintext — never
    `https://${TR_HOST}.evil.example/x`, // suffix trick
    `https://register.cacbg.bg/x`, // the OTHER register: different host, different TLS posture
  ]) {
    assert.throws(() => assertTrHost(bad), /host/i, bad);
  }
});

test('a 429 throws RateLimitError and is NEVER retried', async () => {
  let calls = 0;
  const httpGet = async () => {
    calls++;
    return { status: 429, headers: {}, body: Buffer.from('') };
  };
  await assert.rejects(
    () => politeTrGet(deedUrl('115536179'), { httpGet, sleep: async () => {}, tries: 5 }),
    RateLimitError,
  );
  // The whole point: „5 retries with growing backoff" and „429 stops the run" are only consistent
  // if the retry set EXCLUDES 429. One call, not five.
  assert.equal(calls, 1, 'a 429 must not be retried');
});

test('5xx IS retried with growing backoff, up to the try budget', async () => {
  let calls = 0;
  const waits = [];
  const httpGet = async () => {
    calls++;
    return { status: 503, headers: {}, body: Buffer.from('') };
  };
  const res = await politeTrGet(deedUrl('115536179'), {
    httpGet,
    sleep: async (ms) => void waits.push(ms),
    tries: 4,
  });
  assert.equal(calls, 4);
  assert.equal(res.status, 503, 'the last response is returned, not thrown');
  assert.deepEqual(
    waits.map((w, i) => (i === 0 ? true : w > waits[i - 1])),
    [true, true, true],
    `backoff must grow: ${waits.join(',')}`,
  );
});

test('a network throw is retried, then rethrown when the budget is spent', async () => {
  let calls = 0;
  const httpGet = async () => {
    calls++;
    throw new Error('ECONNRESET');
  };
  await assert.rejects(
    () => politeTrGet(deedUrl('115536179'), { httpGet, sleep: async () => {}, tries: 3 }),
    /ECONNRESET/,
  );
  assert.equal(calls, 3);
});

test('a 429 arriving mid-retry aborts immediately instead of finishing the budget', async () => {
  const seq = [503, 503, 429, 200];
  let calls = 0;
  const httpGet = async () => {
    const status = seq[calls++];
    return { status, headers: {}, body: Buffer.from('') };
  };
  await assert.rejects(
    () => politeTrGet(deedUrl('115536179'), { httpGet, sleep: async () => {}, tries: 5 }),
    RateLimitError,
  );
  assert.equal(calls, 3, 'must stop AT the 429, not carry on to the 200 behind it');
});

test('200 and 404 return without any retry', async () => {
  for (const status of [200, 404]) {
    let calls = 0;
    const httpGet = async () => {
      calls++;
      return status === 200 ? okRes() : { status, headers: {}, body: Buffer.from('') };
    };
    const res = await politeTrGet(deedUrl('115536179'), { httpGet, sleep: async () => {} });
    assert.equal(res.status, status);
    assert.equal(calls, 1);
  }
});

test('politeTrGet refuses a foreign host before making any request', async () => {
  let calls = 0;
  const httpGet = async () => {
    calls++;
    return okRes();
  };
  await assert.rejects(
    () => politeTrGet('https://evil.example/CR/api/Deeds/1', { httpGet }),
    /host/i,
  );
  assert.equal(calls, 0, 'the refusal must happen before the network call');
});

test('the crawler identifies itself and points at somewhere to complain', () => {
  // The rate limiter is the operator's only lever on us. Crawling anonymously takes away their
  // ability to distinguish us from an abusive client, or to ask us to stop.
  assert.match(TR_USER_AGENT, /sigma/i);
  assert.match(TR_USER_AGENT, /https:\/\/github\.com\//);
});

test('the default transport is node:https, not fetch', () => {
  // Measured 2026-08-05: the identical live request returns 500/empty via undici fetch and 200 with
  // the full deed via node:https. Pinning the choice so a future "modernise to fetch" tidy-up has to
  // confront it rather than silently break every lookup.
  assert.equal(typeof httpsGet, 'function');
  assert.match(httpsGet.toString(), /https\.get/);
});

test('RateLimitError carries the url and is distinguishable from a generic failure', async () => {
  const httpGet = async () => ({ status: 429, headers: {}, body: Buffer.from('') });
  const err = await politeTrGet(deedUrl('115536179'), { httpGet, sleep: async () => {} }).catch(
    (e) => e,
  );
  assert.ok(err instanceof RateLimitError);
  assert.ok(err instanceof Error);
  assert.match(err.message, /115536179/);
});

// ── response size ─────────────────────────────────────────────────────────────
// The timeout bounds how long a response may STALL; nothing bounded how large it may GROW. A deed is
// ~34 KB measured; an unbounded reader buffers whatever arrives, so a wedged or hostile endpoint could
// have the crawler hold an arbitrary amount of memory. It also composes badly with the parser: the
// erasure regex in deed.mjs backtracks quadratically on unclosed markup (measured 34K→3.7ms,
// 68K→13.5ms, 136K→53.2ms, 272K→215.4ms — ×4 per doubling), and that path is only reachable through a
// body large enough to make it matter. One byte counter bounds both.
test('a response past the cap is refused and the request destroyed, not buffered', async () => {
  const res = fakeRes(200);
  const destroyed = [];
  const p = collectBody(res, { req: { destroy: (e) => destroyed.push(e) }, maxBytes: 1024 });
  res.emit('data', Buffer.alloc(700));
  res.emit('data', Buffer.alloc(700)); // 1400 > 1024
  await assert.rejects(p, /too large|1024/i);
  assert.equal(destroyed.length, 1, 'the socket must be torn down, not left draining');
});

test('a response under the cap still resolves with the WHOLE body', async () => {
  const res = fakeRes(200);
  const p = collectBody(res, { req: { destroy: () => {} }, maxBytes: 1024 });
  res.emit('data', Buffer.from('{"uic":'));
  res.emit('data', Buffer.from('"115536179"}'));
  res.emit('end');
  const out = await p;
  assert.equal(out.status, 200);
  assert.equal(out.body.toString(), '{"uic":"115536179"}');
});

test('the cap leaves real deeds far under it — it bounds abuse, not the register', () => {
  // A measured deed is ~34 KB. The cap must sit well above that or it becomes a correctness bug that
  // silently refuses large-but-legitimate companies.
  assert.ok(MAX_BODY_BYTES >= 1_000_000, `cap ${MAX_BODY_BYTES} is too tight for a real deed`);
});

// A stand-in for an http.IncomingMessage: an emitter carrying a status code.
function fakeRes(status) {
  const e = new EventEmitter();
  e.statusCode = status;
  e.headers = {};
  return e;
}
