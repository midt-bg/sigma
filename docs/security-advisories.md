# Security advisories

## react-router 7.18.0 / postcss 8.5.15 / valibot 1.4.0

Three advisories flagged by the "Dependency audit" CI step (`osv-scanner scan source -L
pnpm-lock.yaml`):

- `postcss@8.5.15` — GHSA-r28c-9q8g-f849 (path traversal via sourceMappingURL auto-load),
  patch-level fix in `8.5.18`. Fixed by a pnpm override.
- `valibot@1.4.0` — GHSA-5qjj-4xww-7phc (`flatten()` crashes on inherited-property keys),
  patch-level fix in `1.4.2`. Fixed by a pnpm override.
- `react-router@7.18.0` — four advisories fixed within the 7.x line (SSR hydration
  constructor injection GHSA-337j-9hxr-rhxg, unauthenticated DoS via inefficient route
  matching GHSA-chx6-hx7r-mcp5, RSCErrorHandler XSS GHSA-h8fp-f39c-q6mh, open redirect via
  backslash GHSA-wrjc-x8rr-h8h6); fixed by bumping the `react-router`/`@react-router/dev`
  pnpm overrides to `^7.18.0`. A fifth advisory, GHSA-qwww-vcr4-c8h2 (CSRF, CVSS 7.1), is
  scoped to react-router's unstable RSC APIs, which this app does not use (verified via
  repo-wide grep), and has no fix in the 7.x line — it is suppressed via `osv-scanner.toml`
  rather than forcing a major-version bump to react-router 8.x.

Verified clean (modulo the documented RSC-only suppression) with OSV-Scanner v2.4.0
(`osv-scanner scan source -L pnpm-lock.yaml`).

Rollout, by branch:

| Branch | Commit SHA |
| --- | --- |
| `feat/map-info-card` (PR #141) | `6b01749` |
