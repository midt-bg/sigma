import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  DATA_TRUST_RULE,
  EMIT_REPORT_POLICY,
  VALUES_BY_REFERENCE_RULE,
} from './system-prompt';

describe('buildSystemPrompt', () => {
  it('always carries the runtime policies (emit-report, values-by-reference, data-trust)', () => {
    const p = buildSystemPrompt();
    expect(p).toContain(EMIT_REPORT_POLICY);
    expect(p).toContain(VALUES_BY_REFERENCE_RULE);
    expect(p).toContain(DATA_TRUST_RULE);
  });

  it('falls back to the full static dictionary when no RAG context is given', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('Речник на данните'); // describeSchema() header
    expect(p).toContain('amount_eur'); // the key money trap
  });

  it('injects RAG schema chunks when provided (and skips the full dictionary)', () => {
    const p = buildSystemPrompt({
      schemaContext: ['СУМИРАЙ САМО amount_eur', 'lots са на grain по лот'],
    });
    expect(p).toContain('Релевантни правила за данните');
    expect(p).toContain('СУМИРАЙ САМО amount_eur');
    expect(p).not.toContain('## Канонични примерни заявки'); // full dictionary not dumped
  });

  it('includes a per-source freshness line when supplied', () => {
    const p = buildSystemPrompt({ freshness: 'D1: 2026-06-18; EOP: на живо' });
    expect(p).toContain('СВЕЖЕСT НА ДАННИТЕ: D1: 2026-06-18; EOP: на живо');
  });
});
