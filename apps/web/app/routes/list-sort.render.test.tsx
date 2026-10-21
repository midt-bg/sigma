// @vitest-environment jsdom
// The „Подреди:" bar marks the sort the loader actually applied: an unknown, empty or upper-case ?sort
// falls back to the default in the query, so the bar and the rail's hidden field say the default too.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import Authorities from './authorities';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(url: string) {
  const Stub = createRoutesStub([
    {
      path: '/authorities',
      Component: Authorities as never,
      loader: () => ({
        page: { items: [], total: 0, nextCursor: null, prevCursor: null },
        facets: { types: [], sectors: [] },
        coverage: { coverageEndYear: 2025 },
      }),
    },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={[url]} />);
  });
}

describe('list sort bar', () => {
  it.each(['bogus', '', 'SPENT'])('marks the default sort for ?sort=%s', async (value) => {
    await render(`/authorities?sort=${value}`);
    const current = container.querySelectorAll('[aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toBe('обща стойност');
    const hidden = container.querySelector<HTMLInputElement>('input[type="hidden"][name="sort"]');
    expect(hidden?.value).toBe('spent');
  });
});
