// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScrollToTop } from './ScrollToTop';

function mockMatchMedia(prefersReducedMotion: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' && prefersReducedMotion,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function scrollTo(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true });
  window.dispatchEvent(new Event('scroll'));
}

describe('ScrollToTop', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalRaf: typeof window.requestAnimationFrame;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockMatchMedia(false);
    window.scrollTo = vi.fn();
    originalRaf = window.requestAnimationFrame; // saved so the global override doesn't leak
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    };
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    window.requestAnimationFrame = originalRaf;
    vi.restoreAllMocks();
  });

  function getButton() {
    return container.querySelector('button.scroll-to-top') as HTMLButtonElement;
  }

  it('is hidden below the SHOW_AFTER_PX threshold', () => {
    act(() => {
      root.render(<ScrollToTop />);
    });
    act(() => {
      scrollTo(399);
    });
    expect(getButton().className).not.toContain('is-visible');
    expect(getButton().getAttribute('aria-hidden')).toBe('true');
  });

  it('becomes visible above the SHOW_AFTER_PX threshold', () => {
    act(() => {
      root.render(<ScrollToTop />);
    });
    act(() => {
      scrollTo(401);
    });
    expect(getButton().className).toContain('is-visible');
    expect(getButton().getAttribute('aria-hidden')).toBe('false');
  });

  it('hides again when scrolling back under the threshold', () => {
    act(() => {
      root.render(<ScrollToTop />);
    });
    act(() => {
      scrollTo(500);
    });
    expect(getButton().className).toContain('is-visible');
    act(() => {
      scrollTo(100);
    });
    expect(getButton().className).not.toContain('is-visible');
  });

  it('coalesces a burst of scroll events into a single frame (ignores events while one is pending)', () => {
    // Hold the rAF callback instead of running it synchronously so a second scroll lands while a
    // frame is still pending. The counting spy is the load-bearing assertion: the burst must schedule
    // exactly ONE frame — without the `if (ticking) return` guard the second scroll schedules a second.
    let pending: FrameRequestCallback | null = null;
    const raf = vi.fn((cb: FrameRequestCallback) => {
      pending = cb;
      return 1;
    });
    window.requestAnimationFrame = raf;
    act(() => {
      root.render(<ScrollToTop />);
    });
    raf.mockClear(); // ignore any frame from the initial mount
    act(() => {
      scrollTo(500); // schedules a frame (ticking = true)
    });
    act(() => {
      scrollTo(600); // frame still pending → coalesced, must NOT schedule another
    });
    expect(raf).toHaveBeenCalledTimes(1); // the two-scroll burst collapsed to a single rAF
    act(() => {
      pending?.(0); // flush the single frame
    });
    expect(getButton().className).toContain('is-visible');
  });

  it('calls window.scrollTo with smooth behavior on click by default', () => {
    act(() => {
      root.render(<ScrollToTop />);
    });
    act(() => {
      getButton().click();
    });
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('calls window.scrollTo with auto behavior when reduced motion is preferred', () => {
    mockMatchMedia(true);
    act(() => {
      root.render(<ScrollToTop />);
    });
    act(() => {
      getButton().click();
    });
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });
});
