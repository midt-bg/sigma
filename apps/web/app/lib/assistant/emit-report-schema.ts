// Moved to `@sigma/report` (issue #167A T1) so `apps/etl` can import the pure report pipeline
// without depending on `@sigma/web`. This shim re-exports the real module unchanged so existing
// `./emit-report-schema` import sites keep resolving.
// Do not add new logic here — edit `packages/report/src/emit-report-schema.ts`.
//
// Explicit (not `export *`) so this module keeps exposing ONLY the emit-schema surface it always did,
// rather than aliasing the whole `@sigma/report` barrel — see review of #80. Mirror any change to the
// real module's exports here.
export { validateEmitShape, EMIT_REPORT_JSON_SCHEMA, type ShapeResult } from '@sigma/report';
