import { describe, expect, it } from 'vitest';
// Importing the config executes resolveOtelEsmRoot() at module load (side effect). That is safe in
// the integration lane — the lane already loads this config to run — and gives us the exported pure
// helper pickOtelStoreEntry to assert against.
import { pickOtelStoreEntry } from '../../../vitest.integration.config';

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

  it('ignores unrelated @opentelemetry/* packages (only @opentelemetry/api matches)', () => {
    const entries = [
      '@opentelemetry+core@1.0.0',
      '@opentelemetry+api@1.9.1',
      '@opentelemetry+sdk@1.0.0',
    ];
    expect(pickOtelStoreEntry(entries, '1.9.1')).toBe('@opentelemetry+api@1.9.1');
  });
});
