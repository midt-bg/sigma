import { describe, expect, it } from 'vitest';
// Importing the config executes resolveOtelEsmRoot() at module load (side effect). That is safe in
// the integration lane — the lane already loads this config to run — and gives us the exported pure
// helper pickOtelStoreEntry to assert against.
import { extractSemverCore, pickOtelStoreEntry } from '../../../vitest.integration.config';

describe('pickOtelStoreEntry (PR #177 review T-001 — deterministic store entry)', () => {
  it('returns null when no @opentelemetry/api entries exist in the store', () => {
    expect(pickOtelStoreEntry(['vitest@4.1.7', '@sigma/db@1.0.0'], '1.9.1')).toBeNull();
    expect(pickOtelStoreEntry([], '1.9.1')).toBeNull();
  });

  it('matches the exact app version when present (preferred over highest semver)', () => {
    // Two hoisted versions; app depends on 1.9.1 (not the highest). Must pick 1.9.1 — the version
    // the app imports — not 2.0.0.
    const entries = [
      '@opentelemetry+api@1.9.1',
      '@opentelemetry+api@2.0.0',
      '@opentelemetry+api@1.8.0',
    ];
    expect(pickOtelStoreEntry(entries, '1.9.1')).toBe('@opentelemetry+api@1.9.1');
  });

  it('matches the exact app version ignoring a peer-dep hash suffix on the store entry', () => {
    // pnpm appends `_…` peer-dep hash to the store dir name; the core semver still matches.
    const entries = ['@opentelemetry+api@1.9.1_@opentelemetry+core@1.0.0'];
    expect(pickOtelStoreEntry(entries, '1.9.1')).toBe(
      '@opentelemetry+api@1.9.1_@opentelemetry+core@1.0.0',
    );
  });

  it('falls back to the highest semver when the app version is absent (deterministic)', () => {
    const entries = [
      '@opentelemetry+api@1.8.0',
      '@opentelemetry+api@2.0.0',
      '@opentelemetry+api@1.9.1',
    ];
    expect(pickOtelStoreEntry(entries, null)).toBe('@opentelemetry+api@2.0.0');
  });

  it('falls back to the highest semver when the app version is present but not in the store', () => {
    const entries = ['@opentelemetry+api@1.8.0', '@opentelemetry+api@1.9.1'];
    expect(pickOtelStoreEntry(entries, '9.9.9')).toBe('@opentelemetry+api@1.9.1');
  });

  it('is deterministic: same input always returns the same output', () => {
    const entries = [
      '@opentelemetry+api@1.9.1',
      '@opentelemetry+api@2.0.0',
      '@opentelemetry+api@1.8.0',
    ];
    const a = pickOtelStoreEntry(entries, null);
    const b = pickOtelStoreEntry([...entries].reverse(), null);
    expect(a).toBe(b);
    expect(a).toBe('@opentelemetry+api@2.0.0');
  });

  // Regression for PR #177 review T-TIE: the previous sort only compared semver cores. When two
  // store entries shared the same core but had different peer-dep hashes (`@opentelemetry+api@1.9.1`
  // vs `@opentelemetry+api@1.9.1_@opentelemetry+core@1.0.0`), `compareSemverDesc` returned 0 and
  // `Array.prototype.sort` preserved the input order — which depends on `readdirSync` and is
  // filesystem-dependent. Add a deterministic secondary tie-break by entry name.
  it('breaks semver-core ties deterministically by entry name (peer-dep hash collision)', () => {
    const entries = [
      '@opentelemetry+api@1.9.1',
      '@opentelemetry+api@1.9.1_@opentelemetry+core@1.0.0',
    ];
    // The 'a' < 'A' locale difference makes `@opentelemetry+api@1.9.1` (no suffix) come before
    // `@opentelemetry+api@1.9.1_…` (with underscore suffix) — chosen as the tie-break here so
    // "the simpler entry wins" is the contract. Reverse the input and assert we still get the
    // same answer.
    const a = pickOtelStoreEntry(entries, null);
    const b = pickOtelStoreEntry([...entries].reverse(), null);
    expect(a).toBe(b);
    expect(a).toBe('@opentelemetry+api@1.9.1');
  });

  it('breaks exact-match ties deterministically by entry name when appVersion matches both cores', () => {
    // Same exact-match scenario: two entries with the same semver core, different peer-dep hash.
    // The exact-match branch must use the same tie-break as the fallback so behaviour is
    // consistent across both branches.
    const entries = [
      '@opentelemetry+api@1.9.1_@opentelemetry+core@1.0.0',
      '@opentelemetry+api@1.9.1',
    ];
    const a = pickOtelStoreEntry(entries, '1.9.1');
    const b = pickOtelStoreEntry([...entries].reverse(), '1.9.1');
    expect(a).toBe(b);
    expect(a).toBe('@opentelemetry+api@1.9.1');
  });

  it('ignores unrelated @opentelemetry/* packages (only @opentelemetry/api matches)', () => {
    const entries = [
      '@opentelemetry+core@1.0.0',
      '@opentelemetry+api@1.9.1',
      '@opentelemetry+sdk@1.0.0',
    ];
    expect(pickOtelStoreEntry(entries, '1.9.1')).toBe('@opentelemetry+api@1.9.1');
  });
});

describe('extractSemverCore (PR #177 review T-008 — semver range parsing)', () => {
  // The previous implementation used `replace(/^[~^>=<\s]+/, '').split(' ').pop()` which returned
  // the LAST whitespace-delimited token — for a compound range like `">=1.9.1 <2.0.0"` that
  // returned the upper bound `<2.0.0`, then `compareSemverDesc` parsed `NaN → 0` and the wrong
  // store entry won the lookup. extractSemverCore pulls the first semver core out of any spec.
  it('returns the exact version for a caret/tilde/exact pin', () => {
    expect(extractSemverCore('^1.9.1')).toBe('1.9.1');
    expect(extractSemverCore('~1.9.1')).toBe('1.9.1');
    expect(extractSemverCore('1.9.1')).toBe('1.9.1');
  });

  it('returns the lower bound for a compound range (the relevant pin)', () => {
    // `>=1.9.1 <2.0.0` — the lower bound is what the app effectively pins against. The previous
    // implementation returned `<2.0.0` and silently lost the lookup.
    expect(extractSemverCore('>=1.9.1 <2.0.0')).toBe('1.9.1');
  });

  it('returns null when no semver core is present', () => {
    expect(extractSemverCore('workspace:*')).toBeNull();
    expect(extractSemverCore('latest')).toBeNull();
    expect(extractSemverCore('file:../local')).toBeNull();
  });

  it('returns null for an empty / whitespace input', () => {
    expect(extractSemverCore('')).toBeNull();
    expect(extractSemverCore('   ')).toBeNull();
  });
});
