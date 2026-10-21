// @vitest-environment jsdom
// /network names the centre it shows: in the „Център:" select (also when the centre is not among the
// picker's entries) and in the title, with a canonical URL that carries only the centre.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { NetworkData } from '@sigma/api-contract';
import Network, { meta } from './network';

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
