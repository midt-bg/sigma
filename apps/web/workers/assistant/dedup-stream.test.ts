import { describe, expect, it } from 'vitest';
import type { DedupHit, DedupLayer } from './dedup';
import type { ProgressEvent, ProgressPhase } from './single-flight';
import {
  DEDUP_LABEL_BG,
  DEDUP_PART,
  PROGRESS_LABELS_BG,
  PROGRESS_PART,
  dedupPart,
  isDedupPart,
  isProgressPart,
  progressPart,
} from './dedup-stream';

const ALL_LAYERS: DedupLayer[] = ['L0', 'L1', 'L2', 'L2.5', 'L3'];
const ALL_PHASES: ProgressPhase[] = ['planning', 'querying', 'composing', 'binding'];

describe('dedupPart', () => {
  it('maps a cache hit to a data-dedup part with BG label', () => {
    const hit: DedupHit = { reportId: 'rep_1', createdAt: '2026-06-26T10:00:00Z', layer: 'L2' };
    const part = dedupPart(hit);
    expect(part.type).toBe(DEDUP_PART);
    expect(part.data).toEqual({
      reportId: 'rep_1',
      createdAt: '2026-06-26T10:00:00Z',
      layer: 'L2',
      label: DEDUP_LABEL_BG,
    });
  });

  it('preserves the hit layer for every layer', () => {
    for (const layer of ALL_LAYERS) {
      const part = dedupPart({ reportId: 'r', createdAt: 't', layer });
      expect(part.data.layer).toBe(layer);
    }
  });
});

describe('progressPart', () => {
  it('stamps the canonical BG label for each phase and preserves the phase', () => {
    for (const phase of ALL_PHASES) {
      const event: ProgressEvent = { phase, label: 'internal-diagnostic' };
      const part = progressPart(event);
      expect(part.type).toBe(PROGRESS_PART);
      expect(part.data.phase).toBe(phase);
      expect(part.data.label).toBe(PROGRESS_LABELS_BG[phase]);
    }
  });

  it('ignores the event diagnostic label in favour of the canonical copy', () => {
    const part = progressPart({ phase: 'querying', label: 'raw SQL planner step 3' });
    expect(part.data.label).toBe(PROGRESS_LABELS_BG.querying);
    expect(part.data.label).not.toBe('raw SQL planner step 3');
  });
});

describe('Bulgarian copy', () => {
  it('exposes a label for every progress phase', () => {
    expect(Object.keys(PROGRESS_LABELS_BG).sort()).toEqual([...ALL_PHASES].sort());
  });

  it('pins the exact strings (regression guard)', () => {
    expect(DEDUP_LABEL_BG).toBe('Преизползване на съществуващ отчет');
    expect(PROGRESS_LABELS_BG).toEqual({
      planning: 'Планиране на отчета…',
      querying: 'Извличане на данните…',
      composing: 'Съставяне на отчета…',
      binding: 'Свързване на стойностите…',
    });
  });
});

describe('type guards', () => {
  it('isDedupPart matches only the dedup part', () => {
    expect(isDedupPart({ type: DEDUP_PART })).toBe(true);
    expect(isDedupPart({ type: PROGRESS_PART })).toBe(false);
    expect(isDedupPart({ type: 'data-report-ready' })).toBe(false);
  });

  it('isProgressPart matches only the progress part', () => {
    expect(isProgressPart({ type: PROGRESS_PART })).toBe(true);
    expect(isProgressPart({ type: DEDUP_PART })).toBe(false);
    expect(isProgressPart({ type: 'text' })).toBe(false);
  });
});
