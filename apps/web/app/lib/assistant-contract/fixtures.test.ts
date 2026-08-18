// Drift guard for the published contract fixtures (repo convention: tests-with-code).
//
// The "build in parallel against fixtures" plan only holds if the fixtures actually match the shapes
// the four lanes import. These checks fail if a fixture drifts from `ResolvedReport` / `StoredReport`
// / the `data-report-ready` part, and additionally verify referential integrity that a pure type
// check can't (JSON imports widen the discriminant to `string`): every provenance source names a real
// snapshot result set, every snapshot result is explained by a source, and snapshot rows align to
// their columns. Run with the web app's test command on a checkout where #80 is present.

import { describe, expect, it } from 'vitest';
import { REPORT_READY_PART } from './stream';
import resolved from './fixtures/resolved-report.sample.json';
import stored from './fixtures/stored-report.sample.json';
import chat from './fixtures/chat-stream.sample.json';

const BLOCK_TYPES = new Set([
  'text',
  'callout',
  'totals',
  'facts',
  'table',
  'bar',
  'flows',
  'timeseries',
]);

describe('assistant-contract fixtures', () => {
  it('resolved-report: titled, ai-generated watermark, only known block types', () => {
    expect(typeof resolved.title).toBe('string');
    expect(resolved.title.length).toBeGreaterThan(0);
    expect(resolved.watermark).toBe('ai-generated');
    expect(resolved.blocks.length).toBeGreaterThan(0);
    for (const b of resolved.blocks) expect(BLOCK_TYPES.has(b.type)).toBe(true);
  });

  it('stored-report: schemaVersion 1, watermark, provenance aligned to snapshot', () => {
    expect(stored.schemaVersion).toBe(1);
    expect(stored.report.watermark).toBe('ai-generated');

    const snapshotHandles = new Set(stored.provenance.snapshot.map((s) => s.handle));
    const sourceHandles = new Set(stored.provenance.sources.map((s) => s.handle));
    // every provenance source points at a real result set …
    for (const h of sourceHandles) expect(snapshotHandles.has(h)).toBe(true);
    // … and every result set is explained by a source (each figure is auditable)
    for (const h of snapshotHandles) expect(sourceHandles.has(h)).toBe(true);

    expect(stored.provenance.freshness.length).toBeGreaterThan(0);

    // rows align to columns
    for (const r of stored.provenance.snapshot) {
      for (const row of r.rows) expect(row.length).toBe(r.columns.length);
    }
  });

  it('chat-stream: carries a report-ready chip part for the dock', () => {
    const parts = chat.messages.flatMap((m) => m.parts ?? []);
    const ready = parts.find((p) => p.type === REPORT_READY_PART) as
      | { data?: { reportId?: string; title?: string } }
      | undefined;
    expect(ready).toBeTruthy();
    expect(typeof ready?.data?.reportId).toBe('string');
    expect(typeof ready?.data?.title).toBe('string');
  });
});
