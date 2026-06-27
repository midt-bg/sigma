import { describe, expect, it } from 'vitest';
import { evaluateIntegrity, type GateLog } from './integrity';

interface Captured {
  level: 'info' | 'warn' | 'error';
  event: Record<string, unknown>;
}

function fakeLog(): GateLog & { events: Captured[] } {
  const events: Captured[] = [];
  return {
    events,
    info: (event) => events.push({ level: 'info', event }),
    warn: (event) => events.push({ level: 'warn', event }),
    error: (event) => events.push({ level: 'error', event }),
  };
}

const ok = (name: string) => ({ name, ok: true, skipped: false, detail: 'ok' });

describe('evaluateIntegrity', () => {
  it('logs an ok event and does not throw when all checks pass', () => {
    const log = fakeLog();
    expect(() =>
      evaluateIntegrity(
        [ok('non-empty-corpus'), { name: 'staging-reconciliation', ok: true, skipped: true, detail: 'skip' }],
        log,
      ),
    ).not.toThrow();
    const ev = log.events.find((e) => e.event.event === 'etl_integrity_ok');
    expect(ev?.level).toBe('info');
    expect(ev?.event).toMatchObject({ ran: 1, skipped: 1 });
    expect(log.events.some((e) => e.level === 'error')).toBe(false);
  });

  it('alerts (warn) but does not throw on a warn-only result', () => {
    const log = fakeLog();
    expect(() =>
      evaluateIntegrity(
        [{ name: 'date-sanity', ok: true, skipped: false, warn: true, detail: 'future date' }],
        log,
      ),
    ).not.toThrow();
    expect(
      log.events.some((e) => e.level === 'warn' && e.event.event === 'etl_integrity_warn'),
    ).toBe(true);
  });

  it('alerts (error) and throws on a real violation', () => {
    const log = fakeLog();
    expect(() =>
      evaluateIntegrity(
        [{ name: 'rollup-reconciliation', ok: false, skipped: false, detail: 'drift' }],
        log,
      ),
    ).toThrow(/integrity gate failed: rollup-reconciliation/);
    const ev = log.events.find((e) => e.event.event === 'etl_integrity_violation');
    expect(ev?.level).toBe('error');
    expect(ev?.event.checks).toEqual([{ name: 'rollup-reconciliation', detail: 'drift' }]);
  });

  it('does not throw when a failing check is merely skipped', () => {
    const log = fakeLog();
    expect(() =>
      evaluateIntegrity(
        [{ name: 'rollup-reconciliation', ok: true, skipped: true, detail: 'rollups absent' }],
        log,
      ),
    ).not.toThrow();
    expect(log.events.some((e) => e.event.event === 'etl_integrity_violation')).toBe(false);
  });
});
