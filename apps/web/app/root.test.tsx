// @vitest-environment jsdom
// The root error boundary renders a 404/500 inside the site chrome. The accessibility widget is part
// of that chrome: without it a saved contrast theme, font size or text-only mode was dropped on exactly
// the page where something went wrong.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useRouteError } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './root';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it('keeps the accessibility widget and the scroll-to-top button on an error page', async () => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  const accessibility = vi.fn();
  vi.stubGlobal('accessibility', accessibility);
  const Boundary = () => (
    <ErrorBoundary {...({ error: useRouteError() } as Parameters<typeof ErrorBoundary>[0])} />
  );
  const router = createMemoryRouter([
    {
      path: '/',
      loader: () => {
        throw new Response('', { status: 404 });
      },
      Component: () => null,
      ErrorBoundary: Boundary,
    },
  ]);
  const container = document.body.appendChild(document.createElement('div'));
  await act(async () => {
    root = createRoot(container);
    root.render(<RouterProvider router={router} />);
  });
  expect(container.querySelector('main h1')).not.toBeNull();
  expect(container.querySelector('.scroll-to-top')).not.toBeNull();
  expect(accessibility).toHaveBeenCalledWith(
    expect.objectContaining({ navSelector: '.site-nav', mainSelector: 'main' }),
  );
});
