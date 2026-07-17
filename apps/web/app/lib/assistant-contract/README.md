# Assistant contracts

Three typed shapes at the three seams between nedda76's backend (#80) and our lanes (renderer,
persist, dock). Publish once → four people build in parallel against the fixtures, then swap fixtures
for live data when both sides land. Two of the three already (half-)exist in #80, so this is cheap.

| #   | Seam                            | Type                                                             | Fixture                                | Status                  |
| --- | ------------------------------- | ---------------------------------------------------------------- | -------------------------------------- | ----------------------- |
| 1   | block-spec — backend → renderer | `ResolvedReport` (re-exported from #80 `report-schema.ts`)       | `fixtures/resolved-report.sample.json` | exists in #80 (spec §4) |
| 2   | R2 object — persist → renderer  | `StoredReport` (`report.ts`, our lane)                           | `fixtures/stored-report.sample.json`   | new (spec §5)           |
| 3   | chat stream — backend → dock    | AI SDK UIMessage stream + `data-report-ready` part (`stream.ts`) | `fixtures/chat-stream.sample.json`     | half-exists in #80      |

## How each lane uses it

- **Renderer (`/reports/:id`)** — import `StoredReport` from `./report`; render `stored.report`
  (`ResolvedReport`) onto `DataTable`/`StackedBar`/`SankeyDiagram`/`FactsList`/`TotalsStrip` + the new
  `timeseries`; surface `stored.provenance` (per-source freshness, "view the query", the watermark).
  **Render `text`/`callout` markdown with raw-HTML passthrough DISABLED** — values are pre-sanitized by
  #80's `bindReport` (spec §7), but the guarantee is lost if the markdown renderer re-introduces an
  HTML sink. Build entirely against `stored-report.sample.json`.
- **Persist (⑥)** — import `StoredReport`; after `bindReport()` yields a `ResolvedReport`, wrap it with
  provenance and write one immutable JSON to R2 under a random id. The fixture is your output target.
- **Dock** — use `useChat` from `@ai-sdk/react` against `/assistant/chat`; render text + tool parts
  normally; on a `data-report-ready` part (`isReportReadyPart`) drop a chip linking to `/reports/:id`.
  Build against `chat-stream.sample.json`.

## Source of truth, base, direction

- Contract #1's vocabulary lives in **#80's `report-schema.ts`** — we only re-export it (`report.ts`),
  never copy it. Change the block vocabulary there, not here.
- **Dependency direction:** `assistant-contract` MAY import from `assistant/`; `assistant/` must NEVER
  import from `assistant-contract/`.
- Authored on top of **#80 (`feat/ai-assistant-impl`)** so the re-export resolves. **Rebase onto
  `main` once #80 merges.** (Design rationale lives in spec §4/§5/§7 plus the §9 hardening review in
  PR #79 — §9 / the agent-team addendum are not on this branch, so code comments cite the stable §4/§5/§7.)
- **Versioning (read contract):** the writer pins `schemaVersion: 1`; `/reports/:id` must switch on
  `schemaVersion`, keep old branches forever, and treat an unknown future version as best-effort
  render (banner), not a hard failure. Bump `STORED_REPORT_SCHEMA_VERSION` only on a breaking change.
- **Placement:** interim home in `apps/web/app/lib/` because contract #1 must import #80's
  `report-schema.ts` (also in `apps/web`). End-state: once #80's schema is stable, promote the
  vocabulary into `packages/api-contract` (or a new `@sigma/assistant-contract`) and re-export from
  there, inverting today's direction. Note `packages/api-contract` already exports a **different**
  `EntityKind` (`company | consortium`) than the assistant's (`company | authority | contract`) —
  namespace them on any future merge.

## Fixtures

- `resolved-report` / `stored-report` use **fabricated placeholders** (`Компания А`–`Д`, zero-prefixed
  EIKs) on purpose: this product's core risk is wrong numbers on a real firm, so sample data must not
  name a real entity. `fixtures.test.ts` asserts they conform to the types and that provenance aligns
  to the snapshot (run with the web app's test command on a checkout where #80 is present).
- `chat-stream.sample.json` is a `{_note, messages}` wrapper, **not** a bare `UIMessage[]`. Its
  `tool-run_sql` part uses the **AI SDK v6** UIMessage tool-part shape (`type: 'tool-<name>'`, `state`,
  `input`/`output`) — correct, not the v4 `tool-invocation` shape. The run_sql `output` payload is
  illustrative; pin it to #80's `tools.ts`.

## Open seam questions (resolve with nedda76 before wiring)

1. **`emit_report` → id.** #80 returns the `ResolvedReport` inline with no id. The persist lane must
   store it and stream the `data-report-ready` part. Agree where persist hooks in (after
   `finalizeReport`, server-side) so the model never sees the id.
2. **`link.idCol` projection.** A `table` block's `link.idCol` (e.g. `eik`) must be present in the
   resolved row for the renderer to build the href. #80's `bindReport` projects only `columns[].key`,
   so **`idCol` must currently be a displayed column** (the fixtures keep `eik` visible). Either fix
   `bindReport` to always project `link.idCol`, or keep the constraint.
3. **`run_sql` tool-output shape.** Pin the `tool-run_sql` `output` in the stream to #80's `tools.ts`
   so the dock's status rendering matches.
4. **Per-source freshness + provenance.** `provenance.freshness` and `provenance.sources` should be
   derived from the served `data_freshness` view (per `admin`/`ocds`, + the `eop_fetch` date). Curated
   tools and `eop_fetch` produce snapshot rows with no SQL — `sources[].sql` is optional, `tool` names
   the path.
5. **R2 lifecycle / 404.** Spec §5 allows stale reports to be deleted (a chip may 404). Define the
   renderer + dock behaviour for a missing report (regenerate vs. message) — a persist↔renderer seam.
6. **Corpus version (reproducibility).** `freshness.asOf` dates are a proxy; a stronger anchor would be
   a dataset/ingest id. Open whether to add `provenance.corpusVersion`.
