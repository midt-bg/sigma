import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useTurnstileGate } from './useTurnstileGate';
import { nextTurnstileToken } from './turnstile-token';

// Real jsdom tests for the invisible-Turnstile hook. The paths that hide bugs — and that manual
// preview testing can't hit — are the async ones: the post-unmount `cancelled` guard, the shared
// `settle()` (widget callback vs the 8s timeout), the single-in-flight mint guard, and the cleanup.
//
// Strategy: pre-set `window.turnstile` so `loadTurnstileScript()` short-circuits to a resolved promise
// (no real script fetch); a fake API captures the render options so the test can drive the widget
// callbacks directly. The script-load path (window.turnstile absent) is exercised separately at the end.

interface RenderOpts {
  sitekey: string;
  execution: string;
  callback: (t: string) => void;
  'error-callback': () => void;
  'expired-callback': () => void;
  'timeout-callback': () => void;
}

let renderOpts: RenderOpts | null;
let containerEl: HTMLElement | null;
let api: {
  render: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

const withTurnstile = () => {
  renderOpts = null;
  containerEl = null;
  api = {
    render: vi.fn((el: HTMLElement, opts: RenderOpts) => {
      containerEl = el;
      renderOpts = opts;
      return 'widget-1';
    }),
    execute: vi.fn(),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  (window as unknown as { turnstile: unknown }).turnstile = api;
};

afterEach(() => {
  cleanup();
  delete (window as unknown as { turnstile?: unknown }).turnstile;
  document.body.innerHTML = '';
  document.head.querySelectorAll('script').forEach((s) => s.remove());
  vi.useRealTimers();
});

describe('useTurnstileGate — no-op paths', () => {
  it('registers no minter without a site key (server gate is a no-op too)', async () => {
    withTurnstile();
    renderHook(() => useTurnstileGate(null));
    await flush();
    expect(api.render).not.toHaveBeenCalled();
    expect(await nextTurnstileToken()).toBeNull();
  });
});

describe('useTurnstileGate — mint lifecycle (window.turnstile present)', () => {
  beforeEach(withTurnstile);

  it('renders the invisible execute-mode widget and registers a minter', async () => {
    renderHook(() => useTurnstileGate('site-1'));
    await flush();
    expect(api.render).toHaveBeenCalledTimes(1);
    expect(renderOpts?.sitekey).toBe('site-1');
    expect(renderOpts?.execution).toBe('execute');
    // container is the hidden host div appended to the body
    expect(containerEl && document.body.contains(containerEl)).toBe(true);
  });

  it('mints a fresh token: reset()+execute() then resolves on the widget callback', async () => {
    renderHook(() => useTurnstileGate('site-1'));
    await flush();

    const p = nextTurnstileToken();
    await Promise.resolve(); // let the minter body run
    expect(api.reset).toHaveBeenCalledWith('widget-1');
    expect(api.execute).toHaveBeenCalledWith('widget-1');

    act(() => renderOpts!.callback('TOKEN-abc'));
    expect(await p).toBe('TOKEN-abc');
  });

  it('resolves null when the widget reports error/expired/timeout', async () => {
    renderHook(() => useTurnstileGate('site-1'));
    await flush();

    for (const cb of ['error-callback', 'expired-callback', 'timeout-callback'] as const) {
      const p = nextTurnstileToken();
      await Promise.resolve();
      act(() => renderOpts![cb]());
      expect(await p).toBeNull();
    }
  });

  it('guards a single in-flight mint: a concurrent call resolves null without re-executing', async () => {
    renderHook(() => useTurnstileGate('site-1'));
    await flush();

    const first = nextTurnstileToken();
    await Promise.resolve();
    expect(api.execute).toHaveBeenCalledTimes(1);

    const second = nextTurnstileToken(); // in-flight → guarded
    expect(await second).toBeNull();
    expect(api.execute).toHaveBeenCalledTimes(1); // no second execute

    act(() => renderOpts!.callback('TOKEN-1'));
    expect(await first).toBe('TOKEN-1');
  });

  it('settles null on the 8s execute timeout, and a late callback is a harmless no-op', async () => {
    vi.useFakeTimers();
    renderHook(() => useTurnstileGate('site-1'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const p = nextTurnstileToken();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(await p).toBeNull();

    // The double-settle guard: a callback arriving after the timeout must not throw or re-resolve.
    expect(() => act(() => renderOpts!.callback('LATE'))).not.toThrow();
  });

  it('settles null when execute() throws', async () => {
    api.execute.mockImplementation(() => {
      throw new Error('widget not ready');
    });
    renderHook(() => useTurnstileGate('site-1'));
    await flush();

    expect(await nextTurnstileToken()).toBeNull();
  });

  it('cleans up on unmount: clears the minter, removes the widget and its container', async () => {
    const { unmount } = renderHook(() => useTurnstileGate('site-1'));
    await flush();
    const host = containerEl!;
    expect(document.body.contains(host)).toBe(true);

    unmount();

    expect(api.remove).toHaveBeenCalledWith('widget-1');
    expect(document.body.contains(host)).toBe(false);
    expect(await nextTurnstileToken()).toBeNull(); // minter cleared
  });

  it('settles a pending mint to null when the component unmounts mid-flight', async () => {
    const { unmount } = renderHook(() => useTurnstileGate('site-1'));
    await flush();

    const p = nextTurnstileToken();
    await Promise.resolve();
    unmount(); // cleanup calls settle(null)
    expect(await p).toBeNull();
  });
});

describe('useTurnstileGate — script-load path (window.turnstile absent)', () => {
  // These run last: they touch the module-level script-load cache. window.turnstile stays unset so the
  // real load path runs; a fake script element lets the test drive onload/onerror deterministically.
  let scripts: HTMLScriptElement[];
  let createSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scripts = [];
    const realCreate = document.createElement.bind(document);
    createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'script') scripts.push(el as HTMLScriptElement);
      return el;
    });
  });

  afterEach(() => createSpy.mockRestore());

  it('swallows a script-load failure without throwing and registers no minter', async () => {
    renderHook(() => useTurnstileGate('site-1'));
    await Promise.resolve();
    expect(scripts).toHaveLength(1);

    await act(async () => {
      scripts[0].onerror!(new Event('error'));
      await Promise.resolve();
    });

    expect(await nextTurnstileToken()).toBeNull();
  });

  it('does not render the widget if the component unmounts before the script loads', async () => {
    const renderMock = vi.fn();
    (window as unknown as { turnstile?: unknown }).turnstile = undefined;

    const { unmount } = renderHook(() => useTurnstileGate('site-1'));
    await Promise.resolve();
    expect(scripts).toHaveLength(1);

    unmount(); // cancelled = true, before the script resolves

    // Now the script finishes and turnstile becomes available — the cancelled guard must skip rendering.
    (window as unknown as { turnstile: unknown }).turnstile = { render: renderMock };
    await act(async () => {
      scripts[0].onload!(new Event('load'));
      await Promise.resolve();
    });

    expect(renderMock).not.toHaveBeenCalled();
    expect(await nextTurnstileToken()).toBeNull();
  });
});
