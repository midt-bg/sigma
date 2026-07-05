import { describe, expect, it, vi } from 'vitest';
import { chooseToolChoice, persistReport, resolveMaxSteps } from './agent';
import type { ToolContext } from './tools';
import type { ResolvedReport } from './report-schema';
import type { VerificationOutcome } from './verifier';

describe('resolveMaxSteps', () => {
  it('uses the default for a missing or non-numeric value', () => {
    expect(resolveMaxSteps(undefined)).toBe(6);
    expect(resolveMaxSteps('')).toBe(6);
    expect(resolveMaxSteps('abc')).toBe(6);
  });

  it('falls back to the default for 0 or a negative value (never stalls the loop)', () => {
    expect(resolveMaxSteps('0')).toBe(6);
    expect(resolveMaxSteps('-4')).toBe(6);
  });

  it('clamps an over-large value to the hard ceiling (never uncaps BgGPT calls)', () => {
    expect(resolveMaxSteps('9999')).toBe(20);
  });

  it('passes a sane in-range value through (flooring fractions)', () => {
    expect(resolveMaxSteps('3')).toBe(3);
    expect(resolveMaxSteps('20')).toBe(20);
    expect(resolveMaxSteps('4.9')).toBe(4);
  });
});

describe('chooseToolChoice', () => {
  const base = {
    stepNumber: 2,
    maxSteps: 6,
    hasResults: true,
    reportEmitted: false,
    lastStepFailedEmit: false,
  };

  it('forces a real tool call on the first step (no prose narration of the call)', () => {
    expect(chooseToolChoice({ ...base, stepNumber: 0 })).toBe('required');
  });

  it('lets the model choose freely mid-turn', () => {
    expect(chooseToolChoice({ ...base, stepNumber: 2 })).toBe('auto');
  });

  it('forces emit_report near the budget when data exists but no report yet (no silent turn)', () => {
    // maxSteps 6 → final two steps are 4 and 5.
    expect(chooseToolChoice({ ...base, stepNumber: 4 })).toEqual({
      type: 'tool',
      toolName: 'emit_report',
    });
    expect(chooseToolChoice({ ...base, stepNumber: 5 })).toEqual({
      type: 'tool',
      toolName: 'emit_report',
    });
  });

  it('does NOT force-finalize once a valid report already exists', () => {
    expect(chooseToolChoice({ ...base, stepNumber: 5, reportEmitted: true })).toBe('auto');
  });

  it('does NOT force emit_report near the budget when there is no data to bind', () => {
    expect(chooseToolChoice({ ...base, stepNumber: 5, hasResults: false })).toBe('auto');
  });

  it('forces a retry after a failed emit_report (mid-turn)', () => {
    expect(chooseToolChoice({ ...base, stepNumber: 2, lastStepFailedEmit: true })).toBe('required');
  });

  it('near-budget force-finalize takes precedence over the failed-emit retry', () => {
    expect(chooseToolChoice({ ...base, stepNumber: 5, lastStepFailedEmit: true })).toEqual({
      type: 'tool',
      toolName: 'emit_report',
    });
  });
});

describe('persistReport — role ④ audit trail', () => {
  const report: ResolvedReport = {
    title: 'Договори',
    question: 'Колко?',
    blocks: [],
    watermark: 'ai-generated',
  };

  // Minimal ToolContext: an R2 stub that captures the persisted body, and a db whose freshness query
  // resolves empty (persistReport swallows its errors anyway).
  function makeCtx(): { ctx: ToolContext; puts: { key: string; body: string }[] } {
    const puts: { key: string; body: string }[] = [];
    const ctx = {
      db: { prepare: () => ({ all: async () => ({ results: [] }) }) },
      results: [],
      sources: [],
      userQuestion: 'Колко?',
      reports: {
        put: async (key: string, body: string) => {
          puts.push({ key, body });
        },
      },
    } as unknown as ToolContext;
    return { ctx, puts };
  }

  it('persists the verification block including diagnostic errors on the error status', async () => {
    const { ctx, puts } = makeCtx();
    const verification: VerificationOutcome = {
      report,
      status: 'error',
      strippedClaimIds: ['C1'],
      uncertainClaimIds: ['C0'],
      errors: ['verifier call failed: timeout'],
    };
    const id = await persistReport(ctx, report, 'bggpt-x', verification);
    expect(id).not.toBeNull();
    const stored = JSON.parse(puts[0].body);
    expect(stored.provenance.verification).toEqual({
      status: 'error',
      strippedClaimIds: ['C1'],
      uncertainClaimIds: ['C0'],
      errors: ['verifier call failed: timeout'],
    });
  });

  it('omits errors when the pass succeeded, and omits verification entirely when not run', async () => {
    const { ctx, puts } = makeCtx();
    await persistReport(ctx, report, 'bggpt-x', {
      report,
      status: 'verified',
      strippedClaimIds: [],
      uncertainClaimIds: [],
    });
    const verified = JSON.parse(puts[0].body);
    expect(verified.provenance.verification).toEqual({
      status: 'verified',
      strippedClaimIds: [],
      uncertainClaimIds: [],
    });
    expect('errors' in verified.provenance.verification).toBe(false);

    // No verification argument → additive field absent (pre-verifier reports still validate).
    await persistReport(ctx, report, 'bggpt-x');
    const noVer = JSON.parse(puts[1].body);
    expect('verification' in noVer.provenance).toBe(false);
    expect(noVer.schemaVersion).toBe(1);
  });
});
