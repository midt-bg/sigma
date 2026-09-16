// @vitest-environment jsdom
// /conflicts/company/:eik at its edges: a request with no :eik is a 404 before anything is read, and a company
// whose links carry no contracts and no money shows zeros — without an „от … на дружеството" line for a total
// it does not have.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import ConflictCompany, { loader } from './conflict.company';

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

describe('/conflicts/company/:eik — edges', () => {
  it('404s a request without an :eik before any read', async () => {
    // No env at all: the guard must answer before the database is even looked up.
    const thrown = await (async () => loader({ params: {}, context: {} } as never))().then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it('shows zero contracts and no company total when the links carry none', async () => {
    const loaderData = { company: 'АЛФА ООД', eik: '111111111', links: [], contracts: {} };
    const Stub = createRoutesStub([
      { path: '/conflicts/company/:eik', Component: ConflictCompany, loader: () => loaderData },
    ]);
    await act(async () => {
      root.render(<Stub initialEntries={['/conflicts/company/111111111']} />);
    });
    const facts = Object.fromEntries(
      [...container.querySelectorAll('dl.facts .row')].map((row) => [
        row.querySelector('dt')?.textContent,
        row.querySelector('dd'),
      ]),
    );
    expect(container.querySelector('h1')?.textContent).toBe('АЛФА ООД');
    expect(facts['Договори']?.textContent).toBe('0 договора');
    expect(facts['Публични средства']?.textContent).toContain('в декларирания период');
    expect(facts['Публични средства']?.querySelector('.sub')).toBeNull();
    expect(container.textContent).not.toContain('на дружеството по обществени поръчки');
  });
});
