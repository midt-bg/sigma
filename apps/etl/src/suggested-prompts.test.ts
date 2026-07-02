import { describe, expect, it, vi } from 'vitest';
import {
  buildSlot1,
  buildSlot2,
  buildSlot3,
  buildSlot4,
  generateSuggestedPrompts,
  sanitizeName,
  slot1OutlierSuppressed,
} from './suggested-prompts';

// NBSP — `money`/`count` separate the magnitude and unit with a non-breaking space; we hardcode it in
// the expected label literals so the assertion reads cleanly.
const NB = ' ';

describe('sanitizeName', () => {
  it('strips an embedded <script> tag content boundary intact (no HTML stripping, escaped downstream)', () => {
    // Defence-in-depth is about control chars + length; HTML escaping is the renderer's job. The name
    // text passes through verbatim apart from whitespace collapse.
    expect(sanitizeName('Институция <script>')).toBe('Институция <script>');
  });

  it('collapses a newline-injected name to a single line', () => {
    expect(sanitizeName('Ред1\nРед2')).toBe('Ред1 Ред2');
  });

  it('strips a right-to-left override control character', () => {
    expect(sanitizeName('Име‮Друго')).toBe('ИмеДруго');
  });

  it('strips a zero-width space', () => {
    expect(sanitizeName('Институ​ция')).toBe('Институция');
  });

  it('caps a 200-character name to 80 characters plus an ellipsis', () => {
    const long = 'а'.repeat(200);
    const out = sanitizeName(long);
    expect(out).toBe('а'.repeat(80) + '…');
  });
});

describe('slot1OutlierSuppressed', () => {
  it('suppresses when the top is 10000× the runner-up', () => {
    expect(slot1OutlierSuppressed(10_000_000, 1000)).toBe(true);
  });

  it('does not suppress when the top is only ~2× the runner-up', () => {
    expect(slot1OutlierSuppressed(2000, 1000)).toBe(false);
  });

  it('does not suppress when there is no runner-up', () => {
    expect(slot1OutlierSuppressed(9000, undefined)).toBe(false);
  });

  it('suppresses exactly at the 10× threshold', () => {
    expect(slot1OutlierSuppressed(10_000, 1000)).toBe(true);
  });
});

describe('buildSlot1', () => {
  it('embeds the money figure, sanitized authority name, and sector label', () => {
    const built = buildSlot1(
      [{ authority: 'Институция А', amount_eur: 9000, value_flag: 'ok', div: '45' }],
      '2024-01-03',
      '2024-01-10',
    );
    expect(built?.label).toBe(
      `Най-голяма поръчка, подписана 2024-01-03–2024-01-10: 9${NB}хил.${NB}€ — Институция А (Строителни и монтажни работи)`,
    );
  });

  it('uses a number-free period send query that carries no authority name', () => {
    const built = buildSlot1(
      [{ authority: 'Институция А', amount_eur: 9000, value_flag: 'ok', div: '45' }],
      '2024-01-03',
      '2024-01-10',
    );
    expect(built?.sendQuery).toBe(
      'Покажи най-голямата поръчка, подписана в периода 2024-01-03–2024-01-10.',
    );
  });

  it('suppresses the authority name on an outlier pick', () => {
    const built = buildSlot1(
      [
        { authority: 'Институция А', amount_eur: 10_000_000, value_flag: 'ok', div: '45' },
        { authority: 'Институция Б', amount_eur: 1000, value_flag: 'ok', div: '45' },
      ],
      '2024-01-03',
      '2024-01-10',
    );
    expect(built?.label).toBe(
      `Най-голяма поръчка, подписана 2024-01-03–2024-01-10: 10${NB}млн.${NB}€`,
    );
  });

  it('returns null when no rows', () => {
    expect(buildSlot1([], '2024-01-03', '2024-01-10')).toBe(null);
  });
});

describe('buildSlot2', () => {
  it('labels the top sector with money and contract count', () => {
    const built = buildSlot2({ div: '45', eur: 17_000, n: 4 }, '2024-01-03', '2024-01-10');
    expect(built?.label).toBe(
      `Сектор с най-много средства 2024-01-03–2024-01-10: Строителни и монтажни работи — 17${NB}хил.${NB}€ по 4 договора`,
    );
  });

  it('returns null for an unknown CPV division', () => {
    expect(buildSlot2({ div: '99', eur: 17_000, n: 4 }, '2024-01-03', '2024-01-10')).toBe(null);
  });
});

describe('buildSlot3', () => {
  it('labels window activity with count and money', () => {
    const built = buildSlot3({ n: 5, eur: 17_500 }, '2024-01-03', '2024-01-10');
    expect(built.label).toBe(`Подписани 2024-01-03–2024-01-10: 5 договора за 18${NB}хил.${NB}€`);
  });
});

describe('buildSlot4', () => {
  it('drops the slot when the total sample is below 20', () => {
    expect(buildSlot4({ single: 2, total: 3 }, '2024-01-03', '2024-01-10')).toBe(null);
  });

  it('labels the single-offer share as a percentage at the sample floor', () => {
    const built = buildSlot4({ single: 5, total: 20 }, '2024-01-03', '2024-01-10');
    expect(built?.label).toBe(
      `5 от 20 договора с известен брой оферти (25%) са с една оферта, 2024-01-03–2024-01-10`,
    );
  });
});

// Fake-D1 end-to-end (mirrors eop.test.ts's prepare() mock): generateSuggestedPrompts reads as_of,
// runs the slot queries, and UPSERTs each produced slot. We capture the bound UPSERT rows.
interface UpsertCall {
  slot: number;
  label: string;
  sendQuery: string;
  signal: string;
}

function fakeDb(upserts: UpsertCall[]): D1Database {
  const db = {
    prepare(sql: string) {
      if (sql.includes('FROM home_totals')) {
        return { first: async () => ({ value_eur: 25_000, as_of: '2024-01-10' }) };
      }
      if (sql.includes('WHERE amount_eur IS NOT NULL') && sql.includes('FROM contracts WHERE')) {
        return { first: async () => ({ eur: 25_000 }) };
      }
      if (sql.includes('ORDER BY\n  c.amount_eur DESC') || sql.includes('ORDER BY c.amount_eur')) {
        return {
          bind: () => ({
            all: async () => ({
              results: [
                { authority: 'Институция А', amount_eur: 9000, value_flag: 'ok', div: '45' },
                { authority: 'Институция Б', amount_eur: 5000, value_flag: 'ok', div: '45' },
              ],
            }),
          }),
        };
      }
      if (sql.includes('GROUP BY')) {
        return { bind: () => ({ first: async () => ({ div: '45', eur: 17_000, n: 4 }) }) };
      }
      if (sql.includes('COUNT(*) AS n')) {
        return { bind: () => ({ first: async () => ({ n: 5, eur: 17_500 }) }) };
      }
      if (sql.includes('SUM(CASE WHEN')) {
        return { bind: () => ({ first: async () => ({ single: 6, total: 24 }) }) };
      }
      if (sql.includes('INSERT INTO assistant_prompts')) {
        return {
          bind: (slot: number, label: string, sendQuery: string, signal: string) => ({
            run: async () => {
              upserts.push({ slot, label, sendQuery, signal });
              return { success: true };
            },
          }),
        };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
    },
  };
  return db as unknown as D1Database;
}

describe('generateSuggestedPrompts (fake D1)', () => {
  it('UPSERTs all four slots in order', async () => {
    const upserts: UpsertCall[] = [];
    await generateSuggestedPrompts(fakeDb(upserts), new Date('2024-01-11T06:00:00Z'));
    expect(upserts.map((u) => u.slot)).toStrictEqual([1, 2, 3, 4]);
  });

  it('writes the same labels on a second run (idempotent)', async () => {
    const first: UpsertCall[] = [];
    const second: UpsertCall[] = [];
    await generateSuggestedPrompts(fakeDb(first), new Date('2024-01-11T06:00:00Z'));
    await generateSuggestedPrompts(fakeDb(second), new Date('2024-01-11T06:00:00Z'));
    expect(second.map((u) => u.label)).toStrictEqual(first.map((u) => u.label));
  });

  it('returns without writing when as_of is null', async () => {
    const upserts: UpsertCall[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = {
      prepare() {
        return { first: async () => ({ value_eur: 0, as_of: null }) };
      },
    } as unknown as D1Database;
    await generateSuggestedPrompts(db, new Date('2024-01-11T06:00:00Z'));
    expect(upserts).toStrictEqual([]);
    logSpy.mockRestore();
  });
});
