# ADR-0011: Host-scoped TLS SPKI pinning for register.cacbg.bg

- Status: Accepted
- Date: 2026-07-05
- Deciders: lb, Claude
- Related: `scripts/cacbg/tls.mjs`

## Context

`register.cacbg.bg` serves a valid leaf certificate but **omits the Sectigo intermediate**, so its chain
does not verify against system roots. We must fetch ~135k declaration files from it without either
(a) failing every request, or (b) globally disabling TLS verification (which would expose *all* hosts,
including storage.eop.bg, to MITM).

## Decision

Pin the **leaf public key (SPKI SHA-256)** for this one host, and reject anything else:

- A host-scoped HTTPS agent with `rejectUnauthorized:false` (chain can't be built) **plus** a per-socket
  check that computes the peer cert's SPKI SHA-256 and aborts the request before reading the body if it
  does not equal the pinned value. This is strictly *tighter* than trusting the public CA would be.
- The pin, its capture date, and the cert expiry are recorded in `tls.mjs`; `getPinned()` refuses any
  host other than `register.cacbg.bg`.

## Consequences

- No global TLS weakening; other ingest paths keep full verification.
- The pin must be refreshed when the leaf cert renews (expiry noted in code). A renewal → hard failure
  (fail-closed), not silent MITM exposure.
- **Production should instead bundle the Sectigo intermediate as `ca:` with `rejectUnauthorized:true`** —
  equivalent trust, no pin-rotation maintenance. The pin is the pragmatic spike/local choice.
