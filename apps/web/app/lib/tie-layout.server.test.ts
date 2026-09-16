// The layered layout behind the tie graph. What the reader relies on: the payers stand left of the
// centre and its ties right of it, an arrow always sits on the subcontractor, every edge says what kind of
// tie it is, and nothing is drawn that the network did not contain.
import { describe, expect, it } from 'vitest';
import type { CompanyTieNetwork } from '@sigma/api-contract';
import { boxLabel, edgeText, layoutTies } from './tie-layout.server';

const node = (over: Partial<CompanyTieNetwork['nodes'][number]> = {}) => ({
  id: 'eik:1',
  kind: 'company' as const,
  label: 'АЛФА СТРОЙ АД',
  slug: '1',
  valueEur: 100,
  hop: 0,
  conflictsHref: null,
  ...over,
});
const edge = (over: Partial<CompanyTieNetwork['edges'][number]> = {}) => ({
  from: 'eik:1',
  to: 'eik:2',
  kind: 'consortium' as const,
  directed: false,
  weightEur: 900,
  occurrences: 3,
  href: null,
  ...over,
});
const net = (over: Partial<CompanyTieNetwork> = {}): CompanyTieNetwork => ({
  center: node(),
  nodes: [node(), node({ id: 'eik:2', slug: '2', label: 'БЕТА ИНЖЕНЕРИНГ АД', hop: 1 })],
  edges: [edge()],
  omitted: 0,
  ...over,
});

describe('layoutTies', () => {
  it('puts the institutions that pay the centre to its left and the companies tied to it to its right', () => {
    const l = layoutTies(
      net({
        nodes: [
          node(),
          node({ id: 'eik:2', slug: '2', label: 'БЕТА ИНЖЕНЕРИНГ АД', hop: 1 }),
          node({ id: 'auth:9', kind: 'authority', slug: '9', label: 'ОБЩИНА ТЕСТОВО', hop: 1 }),
        ],
        edges: [
          edge(),
          edge({ from: 'auth:9', to: 'eik:1', kind: 'money', directed: true, weightEur: 700 }),
        ],
      }),
    )!;
    const x = (id: string) => l.nodes.find((n) => n.id === id)!.x;
    expect(x('auth:9')).toBeLessThan(x('eik:1'));
    expect(x('eik:1')).toBeLessThan(x('eik:2'));
    expect(l.nodes.find((n) => n.id === 'auth:9')!.href).toBe('/authorities/9');
  });

  it('keeps the arrow on the subcontractor even when the centre is the subcontractor', () => {
    const l = layoutTies(
      net({ edges: [edge({ from: 'eik:2', to: 'eik:1', kind: 'subcontract', directed: true })] }),
    )!;
    const e = l.edges[0]!;
    const end = e.points[e.points.length - 1]!;
    const centre = l.nodes.find((n) => n.center)!;
    const prime = l.nodes.find((n) => !n.center)!;
    const dist = (n: { x: number; y: number }) => Math.hypot(end.x - n.x, end.y - n.y);
    expect(dist(centre)).toBeLessThan(dist(prime)); // the path ends at the centre, where the arrow belongs
  });

  it('writes the kind of tie on every edge, on the edge', () => {
    const l = layoutTies(net())!;
    const e = l.edges[0]!;
    expect(e.label.text).toBe('съвместно изпълнение');
    const [a, b] = [e.points[0]!, e.points[e.points.length - 1]!];
    expect(e.label.x).toBeGreaterThanOrEqual(Math.min(a.x, b.x));
    expect(e.label.x).toBeLessThanOrEqual(Math.max(a.x, b.x));
  });

  it('draws two different ties between the same pair as two edges', () => {
    const l = layoutTies(net({ edges: [edge(), edge({ kind: 'subcontract', directed: true })] }))!;
    expect(l.edges.map((e) => e.kind)).toEqual(['consortium', 'subcontract']);
  });

  it('sizes a box to its name, and cuts a name too long for the widest box', () => {
    expect(boxLabel('КРАТКО ООД')).toBe('КРАТКО ООД');
    const long = 'ОБЕДИНЕНИЕ С МНОГО ДЪЛГО ИМЕ, КОЕТО НЯМА ДА СЕ ПОБЕРЕ В НИТО ЕДНА КУТИЯ';
    expect(boxLabel(long).endsWith('…')).toBe(true);
    const l = layoutTies(
      net({ nodes: [node(), node({ id: 'eik:2', slug: '2', label: long, hop: 1 })] }),
    )!;
    const [centre, other] = l.nodes;
    expect(other!.name).toBe(long);
    expect(other!.label).toBe(boxLabel(long));
    expect(other!.width).toBeGreaterThan(centre!.width);
    expect(centre!.height).toBeGreaterThan(other!.height); // the centre is the one larger box
  });

  it('skips an edge to a node it was not given, rather than inventing the node', () => {
    const l = layoutTies(net({ edges: [edge(), edge({ to: 'eik:missing' })] }))!;
    expect(l.edges).toHaveLength(1);
    expect(l.nodes.map((n) => n.id)).toEqual(['eik:1', 'eik:2']);
  });

  it('stands the people at the centre right of it, and the companies they reach one column further', () => {
    const l = layoutTies(
      net({
        nodes: [
          node(),
          node({
            id: 'rp:ab',
            kind: 'person',
            slug: 'ab',
            label: 'АННА ПЕТРОВА',
            valueEur: 0,
            hop: 1,
          }),
          node({ id: 'eik:3', slug: '3', label: 'ГАМА ЕООД', hop: 2 }),
        ],
        edges: [
          edge({
            from: 'rp:ab',
            to: 'eik:1',
            kind: 'role',
            weightEur: 0,
            occurrences: 1,
            roles: ['manager'],
            current: true,
          }),
          edge({
            from: 'rp:ab',
            to: 'eik:3',
            kind: 'role',
            weightEur: 0,
            occurrences: 1,
            roles: ['partner'],
            current: false,
          }),
        ],
      }),
    )!;
    const x = (id: string) => l.nodes.find((n) => n.id === id)!.x;
    expect(x('eik:1')).toBeLessThan(x('rp:ab'));
    expect(x('rp:ab')).toBeLessThan(x('eik:3'));
    expect(l.nodes.find((n) => n.id === 'rp:ab')!.href).toBe('/persons/ab');
    // The roles, not the kind, are what a role tie says on its edge.
    expect(l.edges.map((e) => e.label.text)).toEqual(['управител', 'бивш съдружник']);
  });

  it('stands the people an authority’s suppliers share to the right of the suppliers', () => {
    const l = layoutTies(
      net({
        center: node({ id: 'auth:9', kind: 'authority', slug: '9', label: 'ОБЩИНА ТЕСТОВО' }),
        nodes: [
          node({ id: 'auth:9', kind: 'authority', slug: '9', label: 'ОБЩИНА ТЕСТОВО' }),
          node({ id: 'eik:1', hop: 1 }),
          node({ id: 'eik:2', slug: '2', label: 'БЕТА ИНЖЕНЕРИНГ АД', hop: 1 }),
          node({
            id: 'rp:ab',
            kind: 'person',
            slug: 'ab',
            label: 'АННА ПЕТРОВА',
            valueEur: 0,
            hop: 2,
          }),
        ],
        edges: [
          edge({ from: 'auth:9', to: 'eik:1', kind: 'money', directed: true }),
          edge({ from: 'auth:9', to: 'eik:2', kind: 'money', directed: true }),
          edge({
            from: 'rp:ab',
            to: 'eik:1',
            kind: 'role',
            weightEur: 0,
            roles: ['manager'],
            current: true,
          }),
          edge({
            from: 'rp:ab',
            to: 'eik:2',
            kind: 'role',
            weightEur: 0,
            roles: ['partner'],
            current: true,
          }),
        ],
      }),
    )!;
    const x = (id: string) => l.nodes.find((n) => n.id === id)!.x;
    expect(x('auth:9')).toBeLessThan(x('eik:1'));
    expect(x('eik:1')).toBeLessThan(x('rp:ab'));
    expect(x('eik:2')).toBeLessThan(x('rp:ab'));
  });

  it('lays out nothing without a centre or with a lone node', () => {
    expect(layoutTies(net({ center: null }))).toBeNull();
    expect(layoutTies(net({ nodes: [node()] }))).toBeNull();
  });
});

describe('edgeText — a tie through a shared declarant', () => {
  const person = (n: number) => ({ id: `rp:${n}`, name: `Лице ${n}`, href: `/persons/${n}` });
  const stake = (people?: ReturnType<typeof person>[]) =>
    edge({ kind: 'declared_stake', weightEur: 0, occurrences: 1, people });

  it('names the one declarant the two companies share', () => {
    expect(edgeText(stake([person(1)]))).toBe('Лице 1');
  });

  it('counts the declarants when there are several', () => {
    expect(edgeText(stake([person(1), person(2), person(3)]))).toBe('3 общи декларатори');
  });

  it('says only what kind of tie it is when no declarant is listed', () => {
    expect(edgeText(stake([]))).toBe('общо свързано лице');
    expect(edgeText(stake())).toBe('общо свързано лице');
  });
});
