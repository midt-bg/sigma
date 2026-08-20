// Moved to `@sigma/report` (issue #167A T1) so `apps/etl` can import the pure report pipeline
// without depending on `@sigma/web`. This shim re-exports the real module unchanged so existing
// `./verifier` import sites keep resolving.
// Do not add new logic here — edit `packages/report/src/verifier.ts`.
export * from '@sigma/report';
