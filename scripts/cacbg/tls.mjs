// Host-scoped TLS for register.cacbg.bg. The host serves a valid leaf cert but omits the Sectigo
// intermediate, so the chain won't verify against system roots. We do NOT globally disable TLS
// verification — we pin the LEAF public key (SPKI SHA-256) for this ONE host and reject anything else.
// This is strictly tighter than trusting the public CA would be.
//
// Pin captured 2026-07-02 via:
//   openssl s_client -connect register.cacbg.bg:443 </dev/null 2>/dev/null \
//     | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der \
//     | openssl dgst -sha256 -binary | openssl base64
// Leaf: Sectigo DV *.cacbg.bg, valid 2025-12 … 2027-01. When it renews the pin changes → update here.
// (Prod path: bundle the Sectigo intermediate as `ca:` and set rejectUnauthorized:true instead.)

import https from 'node:https';
import crypto from 'node:crypto';

export const CACBG_HOST = 'register.cacbg.bg';
export const CACBG_SPKI_PIN = '5mizySA9ycrkTE02wD9HJ4QuenxwEs9CeuaGCRWZbL8=';

function spkiSha256(x509) {
  const der = x509.publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('base64');
}

// One keep-alive agent; verification happens per-socket below (agents can't verify).
const agent = new https.Agent({ keepAlive: true, maxSockets: 4, rejectUnauthorized: false });

/**
 * GET a register.cacbg.bg URL with leaf-SPKI pinning. Rejects on pin mismatch BEFORE reading the body.
 * @returns {Promise<{status:number, headers:object, body:Buffer}>}
 */
export function getPinned(url, { headers = {}, timeoutMs = 30000 } = {}) {
  const u = new URL(url);
  if (u.hostname !== CACBG_HOST) throw new Error(`getPinned refuses non-CACBG host: ${u.hostname}`);
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        agent,
        headers: {
          'user-agent': 'sigma-transparency (+github.com/midt-bg/sigma)',
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
        res.on('error', reject);
      },
    );
    // No default socket timeout: a connection the server accepts but never answers would hang this slot
    // forever. Bound it and surface as an error so politeGet's retry/backoff handles it like any 5xx.
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error(`request timeout after ${timeoutMs}ms: ${url}`)),
    );
    req.on('socket', (socket) => {
      const verify = () => {
        const cert = socket.getPeerX509Certificate?.();
        if (!cert) return req.destroy(new Error('TLS pin: no peer certificate'));
        const got = spkiSha256(cert);
        // Rotation alarm: fail closed AND say what to do. A mismatch is either the expected leaf renewal
        // (~2027-01 — verify this SPKI out-of-band, then set CACBG_SPKI_PIN to it) or, if unexpected, a
        // possible MITM. Never auto-accept a new pin — that would defeat pinning.
        if (got !== CACBG_SPKI_PIN)
          req.destroy(
            new Error(
              `TLS pin mismatch for ${CACBG_HOST}: got SPKI ${got}, expected ${CACBG_SPKI_PIN}. ` +
                `If CACBG renewed its leaf cert, verify this fingerprint out-of-band and update ` +
                `CACBG_SPKI_PIN in scripts/cacbg/tls.mjs; if unexpected, treat as a possible MITM.`,
            ),
          );
      };
      // keep-alive reuses sockets: verify immediately if already handshaked, else once on connect.
      // Marking the socket stops listeners accumulating across reuse (no MaxListeners leak).
      if (socket.getPeerX509Certificate?.()) verify();
      else if (!socket.__cacbgPinned) {
        socket.__cacbgPinned = true;
        socket.once('secureConnect', verify);
      }
    });
    req.on('error', reject);
  });
}
