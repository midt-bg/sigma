// Moved to `@sigma/report` (issue #167A T1) so `apps/etl` can import the pure report pipeline
// without depending on `@sigma/web`. This shim re-exports the real module unchanged so the ~30
// existing `./report-schema` / `~/lib/assistant/report-schema` import sites keep resolving.
// Do not add new logic here — edit `packages/report/src/report-schema.ts`.
//
// Explicit (not `export *`) so this module keeps exposing ONLY the report-schema surface it always did,
// rather than aliasing the whole `@sigma/report` barrel — see review of #80. Mirror any change to the
// real module's exports here.
export {
  bindReport,
  sanitizeProse,
  stripEntityIdPrefix,
  sanitizeCell,
  findProseNumbers,
  asNumber,
  isImplausibleRatio,
  MAX_RATIO_MAGNITUDE,
} from '@sigma/report';
export type {
  CellFormat,
  EntityKind,
  QueryResult,
  CellRef,
  EmitText,
  EmitCallout,
  EmitTotals,
  EmitFacts,
  EmitTableColumn,
  EmitTable,
  EmitBar,
  EmitFlows,
  EmitTimeseries,
  EmitWeekbars,
  EmitBlock,
  EmitReportInput,
  ResolvedRow,
  ResolvedBlock,
  ResolvedReport,
  BindResult,
  BindOptions,
} from '@sigma/report';
