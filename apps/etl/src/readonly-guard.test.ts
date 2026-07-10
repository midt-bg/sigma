import { describe, expect, it } from 'vitest';

// ETL keeps the write-capable D1 binding (#199): the read-only wrapper must never reach the ETL worker,
// which legitimately writes D1 (staging / refresh-slice). Importing readonlyD1 here would break ingest.
const SOURCES: Record<string, string> = import.meta.glob('./**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('ETL retains the write-capable D1 binding', () => {
  it('no ETL source imports the read-only wrapper', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !path.includes('.test.'))
      .filter(([, src]) => /\breadonlyD1\b/.test(src))
      .map(([path]) => path)
      .sort();

    expect(offenders).toEqual([]);
  });
});
