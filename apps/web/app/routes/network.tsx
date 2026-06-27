import { Form, Link, useNavigation, useSearchParams, useSubmit } from 'react-router';
import { count } from '@sigma/shared';
import { getEntityCounterparties, getEntityNetwork } from '@sigma/db';
import type { Route } from './+types/network';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
import { Pagination } from '../components/Pagination';
import { NetworkGraph } from '../components/NetworkGraph';
import { Callout, Section } from '../components/ui';
import { publicCache } from '../lib/cache';
import { PAGE_SIZE, pageNav } from '../lib/filters';
import { centerToken, parseCenter } from '../lib/network-center';
import { counterpartyRows, networkColumns } from '../lib/entity-tables';

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

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const center = parseCenter(sp.get('center'));
  const db = context.cloudflare.env.DB;
  const data = await getEntityNetwork(db, center);
  // A well-formed but non-existent ?center should 404 like the other entity pages, not render an
  // empty 200 that then gets edge-cached. A missing or malformed ?center keeps the default centre.
  if (center && !data.center) {
    throw new Response('Not Found', { status: 404 });
  }
  // Exhaustive, paginated counterparty list for the resolved centre (`data.center` is the effective
  // centre — the default hub when ?center is absent). The graph caps at the top few; this is the full
  // set, so a big hub's hundreds of counterparties are all reachable below the graph.
  const counterparties = data.center
    ? await getEntityCounterparties(
        db,
        { kind: data.center.kind, id: data.center.id },
        { cursor: sp.get('cursor'), pageSize: PAGE_SIZE.network },
      )
    : null;
  return { data, counterparties };
}

export default function Network({ loaderData }: Route.ComponentProps) {
  const { data, counterparties } = loaderData;
  const [sp] = useSearchParams();
  const submit = useSubmit();
  const navigating = useNavigation().state !== 'idle';
  const centerValue = data.center ? centerToken(data.center) : '';
  const cpNav = counterparties
    ? pageNav({
        base: sp,
        total: counterparties.total,
        pageSize: PAGE_SIZE.network,
        nextCursor: counterparties.nextCursor,
        prevCursor: counterparties.prevCursor,
      })
    : null;

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

            {counterparties && counterparties.total > 0 && (
              <Section
                id="links"
                title={`Всички връзки (${count(counterparties.total)})`}
                hint={
                  counterparties.total > data.edges.filter((e) => e.from === data.center?.id).length
                    ? `Графиката показва само най-големите по стойност; тук е пълният списък с ${count(
                        counterparties.total,
                      )} връзки, по страници.`
                    : 'Пълният списък с връзките на избраната същност.'
                }
              >
                <DataTable
                  columns={networkColumns}
                  rows={counterpartyRows(counterparties)}
                  getKey={(r) => `${r.from}-${r.to}`}
                  caption="Всички връзки"
                />
                {cpNav && counterparties.total > PAGE_SIZE.network && (
                  <Pagination nav={cpNav} pageSize={PAGE_SIZE.network} unit="връзки" />
                )}
              </Section>
            )}
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
