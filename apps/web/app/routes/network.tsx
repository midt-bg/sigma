import { Form, Link, useNavigation, useSubmit } from 'react-router';
import { count, money } from '@sigma/shared';
import {
  authorityIdFromSlug,
  bidderIdFromSlug,
  getEntityNetwork,
  type NetworkParams,
} from '@sigma/db';
import type { Route } from './+types/network';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { DataTable, type Column } from '../components/DataTable';
import { NetworkGraph } from '../components/NetworkGraph';
import { Callout, Section } from '../components/ui';
import { publicCache } from '../lib/cache';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Мрежа на връзките — СИГМА' },
    {
      name: 'description',
      content:
        'Мрежата от връзки около една институция или фирма: преките контрагенти и техните следващи връзки, които разкриват клъстери. Изцяло върху наличните данни.',
    },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

// ?center=a:<eik> | c:<slug>; null falls back to the biggest authority in the query layer.
function parseCenter(token: string | null): NetworkParams | null {
  if (!token) return null;
  const i = token.indexOf(':');
  if (i < 1) return null;
  const kind = token.slice(0, i);
  const slug = token.slice(i + 1);
  if (kind === 'a' && slug) return { kind: 'authority', id: authorityIdFromSlug(slug) };
  if (kind === 'c' && slug) {
    const id = bidderIdFromSlug(slug);
    return id ? { kind: 'company', id } : null;
  }
  return null;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const center = parseCenter(new URL(request.url).searchParams.get('center'));
  const data = await getEntityNetwork(context.cloudflare.env.DB, center);
  // A well-formed but non-existent ?center should 404 like the other entity pages, not render an
  // empty 200 that then gets edge-cached. A missing or malformed ?center keeps the default centre.
  if (center && !data.center) {
    throw new Response('Not Found', { status: 404 });
  }
  return { data };
}

interface LinkRow {
  from: string;
  to: string;
  valueEur: number;
  contracts: number;
}

export default function Network({ loaderData }: Route.ComponentProps) {
  const { data } = loaderData;
  const submit = useSubmit();
  const navigating = useNavigation().state !== 'idle';
  const centerValue = data.center
    ? `${data.center.kind === 'authority' ? 'a' : 'c'}:${data.center.slug}`
    : '';

  const nodeById = new Map(data.nodes.map((n) => [n.id, n] as const));
  // Normalise each row to the real procurement direction (authority -> company), regardless of how the
  // edge is oriented in the graph topology: the institution awards and pays the company, never the
  // reverse. Every edge connects one authority and one company.
  const rows: LinkRow[] = data.edges.map((e) => {
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
  const columns: Column<LinkRow>[] = [
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

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Мрежа на връзките' }]} />
      <main id="main">
        <PageHeader
          kicker="Анализ"
          title="Мрежа на връзките"
          lede="Връзките около една институция или фирма: преките ѝ контрагенти и техните следващи връзки. Откроява клъстери, които общата схема на потоците не показва. Това е фокусирана околност, не целият граф."
        />

        <Form
          method="get"
          className="flow-controls"
          role="group"
          aria-label="Избор на център"
          onChange={(e) => submit(e.currentTarget)}
        >
          <label>
            Център:
            <select name="center" defaultValue={centerValue}>
              <optgroup label="Институции">
                {data.centerOptions.authorities.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Компании">
                {data.centerOptions.companies.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
        </Form>

        <p className="sr-only" role="status">
          {navigating ? 'Обновяване на визуализацията…' : 'Визуализацията е обновена.'}
        </p>

        {data.center && data.nodes.length >= 2 ? (
          <>
            <Section
              id="graph"
              title={
                <>
                  Връзки около <em>{data.center.label}</em>
                </>
              }
              hint="Цветовете различават център, институции и фирми. Дебелината на връзката е стойността."
            >
              <NetworkGraph data={data} />
            </Section>

            <Section id="links" title="Връзки в графа">
              <DataTable
                columns={columns}
                rows={rows}
                getKey={(r) => `${r.from}-${r.to}`}
                caption="Връзки в графа"
              />
            </Section>
          </>
        ) : (
          <Callout variant="warning" title="Няма достатъчно връзки">
            <p style={{ margin: 0 }}>
              За избраната същност няма достатъчно връзки за граф. Изберете друга от менюто.
            </p>
          </Callout>
        )}

        <Callout title="Какво показва">
          <p style={{ margin: 0 }}>
            Преките контрагенти на избраната същност и техните най-големи други връзки. Пълният граф
            не се показва; за общата картина виж <Link to="/flows">потоците</Link>.
          </p>
        </Callout>
      </main>
    </>
  );
}
