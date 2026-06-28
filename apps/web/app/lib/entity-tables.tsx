import { count, money, signedPct, type Locale } from '@sigma/shared';
import type { NetworkData, TrendYear } from '@sigma/api-contract';
import { type Column } from '../components/DataTable';
import type { TFunction } from '../i18n/t';

export interface LinkRow {
  from: string;
  to: string;
  valueEur: number;
  contracts: number;
}

export function trendYearColumns(t: TFunction, locale: Locale): Column<TrendYear>[] {
  return [
    {
      key: 'year',
      header: t('entityTables.year'),
      isTitle: true,
      cell: (r) => (
        <>
          {r.year}
          {r.partial && <span className="muted"> ({t('entityTables.yearPartial')})</span>}
        </>
      ),
    },
    {
      key: 'value',
      header: t('entityTables.value'),
      align: 'money',
      cell: (r) => money(r.valueEur, locale),
    },
    {
      key: 'contracts',
      header: t('entityTables.contracts'),
      align: 'num',
      cell: (r) => count(r.contracts, locale),
    },
    {
      key: 'yoy',
      header: t('entityTables.yoy'),
      align: 'num',
      cell: (r) => (r.yoyPct == null ? '' : signedPct(r.yoyPct, 1, locale)),
    },
  ];
}

export function networkColumns(t: TFunction, locale: Locale): Column<LinkRow>[] {
  return [
    { key: 'from', header: t('entityTables.from'), isTitle: true, cell: (r) => r.from },
    { key: 'to', header: t('entityTables.to'), cell: (r) => r.to },
    {
      key: 'value',
      header: t('entityTables.value'),
      align: 'money',
      cell: (r) => money(r.valueEur, locale),
    },
    {
      key: 'contracts',
      header: t('entityTables.contracts'),
      align: 'num',
      secondary: true,
      cell: (r) => count(r.contracts, locale),
    },
  ];
}

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
