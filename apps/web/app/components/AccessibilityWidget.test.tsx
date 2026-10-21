// @vitest-environment jsdom
// The wrapper around the vendored accessibility toolbar: it starts the toolbar once (now, on load, or
// as soon as the deferred script defines it — and gives up after ten seconds), installs the CSS that
// keeps the skip link and focus rings alive in text-only mode, and has the toolbar rebuild its list of
// headings after each client-side navigation.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Opts = {
  textVersionOnCallbacks: Array<() => void>;
  textVersionOffCallbacks: Array<() => void>;
};

let el: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;
beforeEach(() => {
  // The module remembers that it started the toolbar; each test starts from a fresh copy.
  vi.resetModules();
  vi.useFakeTimers();
  el = document.body.appendChild(document.createElement('div'));
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  document.querySelector('.accessibility-controls')?.remove();
  document.getElementById('a11y-survival')?.remove();
  document.documentElement.className = '';
  delete (document as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete window.accessibility;
  delete window.accessibilityRefreshHeadings;
});

async function mount() {
  const { AccessibilityWidget } = await import('./AccessibilityWidget');
  router = createMemoryRouter([{ path: '*', Component: AccessibilityWidget }]);
  act(() => root.render(<RouterProvider router={router} />));
}

it('starts the toolbar once, with the site’s selectors, and keeps text-only mode legible', async () => {
  // A browser with constructed style sheets (jsdom has none).
  vi.stubGlobal(
    'CSSStyleSheet',
    class {
      replaceSync() {}
    },
  );
  Object.defineProperty(document, 'adoptedStyleSheets', {
    value: [],
    writable: true,
    configurable: true,
  });
  const init = vi.fn();
  window.accessibility = init;
  await mount();
  expect(init).toHaveBeenCalledOnce();
  const opts = init.mock.calls[0]![0] as Opts & Record<string, unknown>;
  expect(opts).toMatchObject({ parentSelector: 'body', navSelector: '.site-nav', lng: 'bg' });
  expect(document.adoptedStyleSheets).toHaveLength(1);

  opts.textVersionOnCallbacks[0]!();
  expect(document.documentElement.classList.contains('a11y-textonly')).toBe(true);
  expect(document.adoptedStyleSheets).toHaveLength(1);
  opts.textVersionOffCallbacks[0]!();
  expect(document.documentElement.classList.contains('a11y-textonly')).toBe(false);

  // A second mount does not start a second toolbar.
  act(() => root.unmount());
  root = createRoot(el);
  await mount();
  expect(init).toHaveBeenCalledOnce();
});

it('falls back to a <style> element where constructed style sheets are missing', async () => {
  vi.stubGlobal('CSSStyleSheet', undefined);
  const init = vi.fn();
  window.accessibility = init;
  await mount();
  const style = document.getElementById('a11y-survival') as HTMLStyleElement;
  expect(style.textContent).toContain('a11y-textonly');
  style.sheet!.disabled = true;
  (init.mock.calls[0]![0] as Opts).textVersionOnCallbacks[0]!();
  expect(document.querySelectorAll('#a11y-survival')).toHaveLength(1);
  expect(style.sheet!.disabled).toBe(false);
});

it('waits for the deferred script, and gives up after ten seconds', async () => {
  await mount();
  const init = vi.fn();
  act(() => vi.advanceTimersByTime(300));
  window.accessibility = init;
  act(() => vi.advanceTimersByTime(100));
  expect(init).toHaveBeenCalledOnce();
});

it('stops waiting after ten seconds without the script', async () => {
  const clear = vi.spyOn(window, 'clearInterval');
  await mount();
  act(() => vi.advanceTimersByTime(10_100));
  expect(clear).toHaveBeenCalled();
  window.accessibility = vi.fn();
  act(() => vi.advanceTimersByTime(1000));
  expect(window.accessibility).not.toHaveBeenCalled();
});

it('leaves a toolbar that is already on the page alone', async () => {
  document.body.insertAdjacentHTML(
    'afterbegin',
    '<div class="accessibility-controls a11y-tools"></div>',
  );
  const init = vi.fn();
  window.accessibility = init;
  await mount();
  expect(init).not.toHaveBeenCalled();
});

it('has the toolbar rebuild its heading links after a client-side navigation', async () => {
  window.accessibility = vi.fn();
  const refresh = vi.fn();
  window.accessibilityRefreshHeadings = refresh;
  await mount();
  refresh.mockClear();
  await act(() => router.navigate('/contracts'));
  expect(refresh).toHaveBeenCalledOnce();
});
