// Minimal test stand-in for the workerd built-in 'cloudflare:workflows' (see the
// cloudflare-workers-stub sibling): src/index.ts imports NonRetryableError to mark a
// deterministic integrity violation as not-worth-retrying. The real class carries workerd
// retry semantics; for vitest all we need is an Error subtype the code can throw and
// tests can match on.
export class NonRetryableError extends Error {}
