// Moved to `@sigma/report` (issue #167A T1) so `apps/etl` can build/persist `StoredReport`s
// without depending on `@sigma/web`. This shim re-exports the real module (now `contract.ts` in
// that package) unchanged so existing `~/lib/assistant-contract/report` import sites keep
// resolving. See ./README.md for the contract's design rationale.
// Do not add new logic here — edit `packages/report/src/contract.ts`.
export * from '@sigma/report';
