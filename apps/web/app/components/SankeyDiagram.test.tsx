// @vitest-environment jsdom
// The bars are links, so the diagram is a labelled group of links rather than an image (an image's
// children are presentational). Each link is named with the node's FULL name, even when the label drawn
// next to the bar is cut with „…".
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SankeyLayout } from '@sigma/api-contract';
import { SankeyDiagram } from './SankeyDiagram';

const longName = 'Община Тест — дирекция за изпитване на дълги имена';
const layout: SankeyLayout = {
  viewBox: '0 0 700 400',
  width: 700,
  height: 400,
  nodes: [
    {
      label: 'Община Тест — дирекция за из…',
      name: longName,
      valueEur: 1000,
      side: 'authority',
      x: 140,
      y: 20,
      width: 12,
      height: 60,
      labelY: 50,
      href: '/authorities/000000001',
    },
    {
      label: 'ТЕСТ ГРУП ЕООД',
      name: 'ТЕСТ ГРУП ЕООД',
      valueEur: 1000,
      side: 'company',
      x: 548,
      y: 20,
      width: 12,
      height: 60,
      labelY: 50,
      href: '/companies/000000002',
    },
  ],
  ribbons: [
    {
      d: 'M0 0',
      title: 'Община Тест → ТЕСТ ГРУП ЕООД',
      fromName: 'Община Тест',
      toName: 'ТЕСТ ГРУП ЕООД',
      valueEur: 1000,
      contracts: 1,
    },
  ],
};

describe('SankeyDiagram', () => {
  it('exposes the bars as named links in a group, not inside an image', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(<SankeyDiagram layout={layout} />);
    const svg = host.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('group');
    expect(svg.getAttribute('aria-label')).toBeTruthy();
    expect(host.querySelector('[role="img"] a')).toBeNull();

    const links = [...svg.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual([
      expect.stringContaining(longName),
      expect.stringContaining('ТЕСТ ГРУП ЕООД'),
    ]);
    expect(links[0]!.querySelector('title')!.textContent).toContain(longName);
  });
});
