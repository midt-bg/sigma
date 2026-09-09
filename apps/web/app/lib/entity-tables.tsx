import { Link } from 'react-router';
import { count, money, signedPct } from '@sigma/shared';
import type { NetworkData, TrendYear } from '@sigma/api-contract';
import { type Column } from '../components/DataTable';

export interface LinkRow {
  from: string;
  to: string;
  /** Profile paths for the two endpoints. The graph beside this table draws the same pair, so if one
   *  is a link and the other is bare text, the accessible fallback is the poorer of the two paths. */
  fromHref: string | null;
  toHref: string | null;
  valueEur: number;
  contracts: number;
}

/** `/authorities/:slug` | `/companies/:slug` for a graph node. */
export function nodeHref(n: { kind: 'authority' | 'company'; slug: string }): string {
  return n.kind === 'authority' ? `/authorities/${n.slug}` : `/companies/${n.slug}`;
}

export const trendYearColumns: Column<TrendYear>[] = [
  {
    key: 'year',
    header: 'Година',
    isTitle: true,
    cell: (r) => (
      <>
        {r.year}
        {r.partial && <span className="muted"> (частично)</span>}
      </>
    ),
  },
  { key: 'value', header: 'Стойност', align: 'money', cell: (r) => money(r.valueEur) },
  { key: 'contracts', header: 'Договори', align: 'num', cell: (r) => count(r.contracts) },
  {
    key: 'yoy',
    header: 'Спрямо предходната',
    align: 'num',
    cell: (r) => (r.yoyPct == null ? '' : signedPct(r.yoyPct)),
  },
];

export const networkColumns: Column<LinkRow>[] = [
  {
    key: 'from',
    header: 'От',
    isTitle: true,
    cell: (r) => (r.fromHref ? <Link to={r.fromHref}>{r.from}</Link> : r.from),
  },
  { key: 'to', header: 'Към', cell: (r) => (r.toHref ? <Link to={r.toHref}>{r.to}</Link> : r.to) },
  { key: 'value', header: 'Стойност', align: 'money', cell: (r) => money(r.valueEur) },
  {
    key: 'contracts',
    header: 'Договори',
    align: 'num',
    secondary: true,
    cell: (r) => count(r.contracts),
  },
];

export function networkRows(data: NetworkData): LinkRow[] {
  const nodeById = new Map(data.nodes.map((n) => [n.id, n] as const));
  return data.edges.map((e) => {
    const a = nodeById.get(e.from);
    const b = nodeById.get(e.to);
    // Pick each side BY KIND rather than by "whichever isn't the authority". Every edge connects one
    // authority and one company, but an endpoint can be missing from `nodes`; the old form then treated
    // the surviving node as the authority whatever it actually was, so an unresolved body put the COMPANY
    // in the „От" column — harmless as grey text, a false claim once the cell became a link.
    const authority = a?.kind === 'authority' ? a : b?.kind === 'authority' ? b : null;
    const company = a?.kind === 'company' ? a : b?.kind === 'company' ? b : null;
    const otherEnd = (n: { id: string }) => (n.id === e.from ? e.to : e.from);
    return {
      from: authority?.label ?? (company ? otherEnd(company) : e.from),
      to: company?.label ?? (authority ? otherEnd(authority) : e.to),
      fromHref: authority ? nodeHref(authority) : null,
      toHref: company ? nodeHref(company) : null,
      valueEur: e.valueEur,
      contracts: e.contracts,
    };
  });
}
