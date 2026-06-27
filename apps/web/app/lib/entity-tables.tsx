import { count, money, signedPct } from '@sigma/shared';
import type { NetworkData, TrendYear } from '@sigma/api-contract';
import { type Column } from '../components/DataTable';

export interface LinkRow {
  from: string;
  to: string;
  valueEur: number;
  contracts: number;
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
  { key: 'from', header: 'От', isTitle: true, cell: (r) => r.from },
  { key: 'to', header: 'Към', cell: (r) => r.to },
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
    const authority = a?.kind === 'authority' ? a : b;
    const company = a?.kind === 'authority' ? b : a;
    return {
      from: authority?.label ?? e.from,
      to: company?.label ?? e.to,
      valueEur: e.valueEur,
      contracts: e.contracts,
    };
  });
}
