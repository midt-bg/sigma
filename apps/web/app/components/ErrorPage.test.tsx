// @vitest-environment jsdom
// The root error boundary renders a 404/500 inside the site chrome. The accessibility widget is part
// of that chrome: without it a saved contrast theme, font size or text-only mode was dropped on exactly
// the page where something went wrong.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRoutesStub } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ErrorPage } from './ErrorPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  el = document.body.appendChild(document.createElement('div'));
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});

async function render(error: unknown) {
  const Stub = createRoutesStub([{ path: '/', Component: () => <ErrorPage error={error} /> }]);
  await act(async () => root.render(<Stub />));
  return el;
}

it('keeps the accessibility widget and the scroll-to-top button on an error page', async () => {
  const accessibility = vi.fn();
  vi.stubGlobal('accessibility', accessibility);
  const c = await render({ status: 404, statusText: 'Not Found', internal: false, data: '' });
  expect(c.querySelector('main h1')!.textContent).toBe('Страницата не е намерена');
  expect(c.querySelector('.scroll-to-top')).not.toBeNull();
  expect(accessibility).toHaveBeenCalledWith(
    expect.objectContaining({ navSelector: '.site-nav', mainSelector: 'main' }),
  );
});

it('shows the stack of an unexpected error in development', async () => {
  const c = await render(new Error('счупено'));
  expect(c.querySelector('.error-stack')!.textContent).toContain('счупено');
});
