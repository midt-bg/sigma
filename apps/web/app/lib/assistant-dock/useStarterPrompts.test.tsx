import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useStarterPrompts } from './useStarterPrompts';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// The hook's effect awaits fetch → response.json() → parsePrompts before it can setState — at least two
// microtask hops. A single `await Promise.resolve()` only drains ONE hop, so a "stays undefined" assertion
// would pass even with the validation removed (the chain simply hasn't finished). Crossing a macrotask
// boundary (setTimeout(0)) guarantees the whole microtask queue — fetch, json, parse, any setState — has
// drained, so the negative assertions actually exercise the rejection path.
const flushAsyncWork = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useStarterPrompts', () => {
  it('returns the parsed prompts on a successful fetch', async () => {
    const prompts = [
      { label: 'Сектор: Строителство — 1 млн. €', send: 'Кои изпълнители спечелиха най-много?' },
      { label: 'Подписани 2024-01-03–2024-01-10', send: 'Покажи договорите.' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ prompts, asOf: '2024-01-10', window: null })),
    );

    const { result } = renderHook(() => useStarterPrompts());

    await waitFor(() => expect(result.current).toStrictEqual(prompts));
  });

  it('stays undefined when the fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const { result } = renderHook(() => useStarterPrompts());

    await flushAsyncWork();
    expect(result.current).toBeUndefined();
  });

  it('stays undefined on an empty prompts list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ prompts: [], asOf: null, window: null })),
    );

    const { result } = renderHook(() => useStarterPrompts());

    await flushAsyncWork();
    expect(result.current).toBeUndefined();
  });

  it('stays undefined on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    const { result } = renderHook(() => useStarterPrompts());

    await flushAsyncWork();
    expect(result.current).toBeUndefined();
  });

  it('stays undefined when an item is malformed (missing send)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ prompts: [{ label: 'Сектор: Строителство' }], asOf: null })),
    );

    const { result } = renderHook(() => useStarterPrompts());

    await flushAsyncWork();
    expect(result.current).toBeUndefined();
  });

  it('stays undefined when an item field has the wrong type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ prompts: [{ label: 1, send: 'Покажи договорите.' }] })),
    );

    const { result } = renderHook(() => useStarterPrompts());

    await flushAsyncWork();
    expect(result.current).toBeUndefined();
  });

  it('rejects a list over the 4-prompt cap', async () => {
    const prompts = Array.from({ length: 5 }, (_, i) => ({
      label: `chip ${i}`,
      send: `send ${i}`,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ prompts })),
    );

    const { result } = renderHook(() => useStarterPrompts());

    await flushAsyncWork();
    expect(result.current).toBeUndefined();
  });

  it('rejects an item field over the length cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ prompts: [{ label: 'x'.repeat(301), send: 'ok' }] })),
    );

    const { result } = renderHook(() => useStarterPrompts());

    await flushAsyncWork();
    expect(result.current).toBeUndefined();
  });
});
