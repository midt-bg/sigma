// @vitest-environment jsdom
// /network names the centre it shows: in the „Център:" select (also when the centre is not among the
// picker's entries) and in the title, with a canonical URL that carries only the centre.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { NetworkData } from '@sigma/api-contract';
const { networkMock } = vi.hoisted(() => ({ networkMock: vi.fn() }));
vi.mock('@sigma/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sigma/db')>()),
  getEntityNetwork: networkMock,
  getDb: (env: unknown) => env,
}));

import Network, { loader, meta } from './network';

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

const data = (slug: string, label: string): NetworkData => ({
  center: { id: `eik:${slug}`, kind: 'company', label, slug, valueEur: 1 },
  nodes: [],
  edges: [],
  centerOptions: {
    authorities: [{ kind: 'authority', label: 'Община Тест', value: 'a:000000001' }],
    companies: [{ kind: 'company', label: 'АЛФА ТЕСТ ООД', value: 'c:111111111' }],
  },
});

async function render(d: NetworkData) {
  const Stub = createRoutesStub([
    { path: '/network', Component: Network as never, loader: () => ({ data: d }) },
    { path: '/flows', Component: () => null },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/network']} />);
  });
}

// HTMLSelectElement's remove(index) clashes with Element's remove() in this lib.dom.
const select = () =>
  container.querySelector('select[name="center"]') as unknown as Pick<
    HTMLSelectElement,
    'value' | 'selectedOptions' | 'options'
  >;

describe('/network centre', () => {
  it('selects the centre by its own name when it is not in the picker', async () => {
    await render(data('222222222', 'ТЕСТ ГРУП ЕООД'));
    expect(select().value).toBe('c:222222222');
    expect(select().selectedOptions[0]!.textContent).toBe('ТЕСТ ГРУП ЕООД');
  });

  it('adds no extra option for a centre the picker already has', async () => {
    await render(data('111111111', 'АЛФА ТЕСТ ООД'));
    expect(select().value).toBe('c:111111111');
    expect(select().options).toHaveLength(2);
  });

  it('names the centre in the title and canonicalises the URL to it', () => {
    const tags = meta({
      data: { data: data('222222222', 'ТЕСТ ГРУП ЕООД') },
      matches: [{ id: 'root', data: { origin: 'https://example.test' } }],
    } as never);
    expect(tags).toContainEqual({ title: 'Мрежа на връзките около ТЕСТ ГРУП ЕООД — СИГМА' });
    expect(tags).toContainEqual({
      tagName: 'link',
      rel: 'canonical',
      href: 'https://example.test/network?center=c:222222222',
    });
  });
});

describe('/network loader', () => {
  const ctx = { cloudflare: { env: {} } };
  const run = (q: string) =>
    loader({ request: new Request(`https://example.test/network${q}`), context: ctx } as never);

  it('reads an authority or a company centre, and falls back on a malformed one', async () => {
    networkMock.mockResolvedValue(data('222222222', 'ТЕСТ ГРУП ЕООД'));
    await run('?center=a:000000001');
    expect(networkMock).toHaveBeenLastCalledWith({}, { kind: 'authority', id: 'auth:000000001' });
    await run('?center=c:222222222');
    expect(networkMock).toHaveBeenLastCalledWith({}, { kind: 'company', id: 'eik:222222222' });
    for (const q of ['', '?center=x', '?center=:1', '?center=z:1', '?center=a:']) {
      await run(q);
      expect(networkMock).toHaveBeenLastCalledWith({}, null);
    }
  });

  it('answers 404 for a well-formed centre that does not exist', async () => {
    networkMock.mockResolvedValue({ ...data('1', 'x'), center: null });
    await expect(run('?center=c:333333333')).rejects.toMatchObject({ status: 404 });
  });
});

describe('/network graph', () => {
  it('draws the graph and the table when the centre has links', async () => {
    const d = data('222222222', 'ТЕСТ ГРУП ЕООД');
    await render({
      ...d,
      nodes: [
        {
          id: 'eik:222222222',
          kind: 'company',
          label: 'ТЕСТ ГРУП ЕООД',
          slug: '222222222',
          valueEur: 10,
          hop: 0,
        },
        {
          id: 'auth:000000001',
          kind: 'authority',
          label: 'Община Тест',
          slug: '000000001',
          valueEur: 10,
          hop: 1,
        },
      ],
      edges: [{ from: 'auth:000000001', to: 'eik:222222222', valueEur: 10, contracts: 1 }],
    });
    expect(container.querySelector('#graph')).not.toBeNull();
    // On a phone the graph section is hidden whole; the table's heading does not name the graph.
    expect(container.querySelector('#graph')!.closest('section')!.classList).toContain(
      'diagram-only',
    );
    expect(container.textContent).toContain('Списък на връзките');
    expect(container.textContent).not.toContain('Няма достатъчно връзки');
  });

  it('says so when there are too few links for a graph', async () => {
    await render(data('222222222', 'ТЕСТ ГРУП ЕООД'));
    expect(container.textContent).toContain('Няма достатъчно връзки');
  });

  it('keeps the generic title without a centre', () => {
    const tags = meta({
      data: { data: { ...data('1', 'x'), center: null } },
      matches: [],
    } as never);
    expect(tags).toContainEqual({ title: 'Мрежа на връзките — СИГМА' });
  });
});
