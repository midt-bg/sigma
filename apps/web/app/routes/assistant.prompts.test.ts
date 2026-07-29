import { describe, expect, it, vi } from 'vitest';
import { loader } from './assistant.prompts';

// The loader only touches context.cloudflare.env.DB.prepare(sql).all(); build the smallest context
// that satisfies that path. Route.LoaderArgs carries more, but the loader reads nothing else, so a
// typed cast at this test boundary is honest.
function makeArgs(db: unknown) {
  return { context: { cloudflare: { env: { DB: db } } } } as unknown as Parameters<
    typeof loader
  >[0];
}

function fakeDb(rows: unknown[]): D1Database {
  return {
    prepare() {
      return { all: async () => ({ results: rows }) };
    },
  } as unknown as D1Database;
}

function throwingDb(): D1Database {
  return {
    prepare() {
      return {
        all: async () => {
          throw new Error('no such table: assistant_prompts');
        },
      };
    },
  } as unknown as D1Database;
}

const ROWS = [
  {
    slot: 1,
    label: 'Най-голяма поръчка 2024-01-03–2024-01-10',
    send_query: 'Покажи най-голямата поръчка.',
    as_of: '2024-01-10',
    window_from: '2024-01-03',
    window_to: '2024-01-10',
  },
  {
    slot: 2,
    label: 'Сектор с най-много средства',
    send_query: 'Кои изпълнители спечелиха най-много?',
    as_of: '2024-01-10',
    window_from: '2024-01-03',
    window_to: '2024-01-10',
  },
];

describe('assistant.prompts loader', () => {
  it('maps seeded rows to {label, send} prompts', async () => {
    const result = await loader(makeArgs(fakeDb(ROWS)));
    expect(await result.data).toStrictEqual({
      prompts: [
        { label: 'Най-голяма поръчка 2024-01-03–2024-01-10', send: 'Покажи най-голямата поръчка.' },
        { label: 'Сектор с най-много средства', send: 'Кои изпълнители спечелиха най-много?' },
      ],
      asOf: '2024-01-10',
      window: { from: '2024-01-03', to: '2024-01-10' },
    });
  });

  it('sets a 15-minute public cache header', async () => {
    const result = await loader(makeArgs(fakeDb(ROWS)));
    expect(new Headers(result.init?.headers).get('Cache-Control')).toBe(
      'public, s-maxage=900, stale-while-revalidate=86400',
    );
  });

  it('returns an empty payload when the DB read throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loader(makeArgs(throwingDb()));
    expect(await result.data).toStrictEqual({ prompts: [], asOf: null, window: null });
    warnSpy.mockRestore();
  });
});
