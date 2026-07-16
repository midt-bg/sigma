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

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockMatchMedia(false);
    window.scrollTo = vi.fn();
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
