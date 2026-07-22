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
import { centerToken, countDirectEdges, parseCenter } from '../lib/network-center';
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
  // `g=1` marks a client re-centre fetch (NetworkGraph.recentre): it consumes only the graph data, so
  // skip the centre-picker options (unchanged) and the counterparties page (the address bar — and the
  // table — don't change on re-centre). Avoids paying for queries the result throws away.
  const graphOnly = sp.get('g') === '1';
  const data = await getEntityNetwork(db, center, { includeCenterOptions: !graphOnly });
  // A well-formed but non-existent ?center should 404 like the other entity pages, not render an
  // empty 200 that then gets edge-cached. A missing or malformed ?center keeps the default centre.
  if (center && !data.center) {
    throw new Response('Not Found', { status: 404 });
  }
  // Exhaustive, paginated counterparty list for the resolved centre (`data.center` is the effective
  // centre — the default hub when ?center is absent). The graph caps at the top few; this is the full
  // set, so a big hub's hundreds of counterparties are all reachable below the graph.
  const counterparties =
    !graphOnly && data.center
      ? await getEntityCounterparties(
          db,
          { kind: data.center.kind, id: data.center.id },
          // Reuse the count getEntityNetwork already computed — no second identical COUNT(*) on /network.
          { cursor: sp.get('cursor'), pageSize: PAGE_SIZE.network, total: data.counterpartyTotal },
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
  // `total === null` means the COUNT itself failed ("unknown"), same convention as
  // NetworkGraph's counterpartyTotal — never fabricate a page count off a failed COUNT. pageNav
  // handles a null total by gating Next on the cursor alone instead of a fabricated page bound.
  const cpTotal = counterparties ? counterparties.total : null;
  const cpNav = counterparties
    ? pageNav({
        base: sp,
        total: cpTotal,
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

            {counterparties && counterparties.rows.length > 0 && (
              <Section
                id="links"
                title={cpTotal === null ? 'Всички връзки' : `Всички връзки (${count(cpTotal)})`}
                hint={
                  cpTotal === null
                    ? 'Пълният списък с връзките на избраната същност (общият им брой не е наличен в момента).'
                    : cpTotal > countDirectEdges(data.edges, data.center?.id)
                      ? `Графиката показва само най-големите по стойност; тук е пълният списък с ${count(
                          cpTotal,
                        )} връзки, по страници.`
                      : 'Пълният списък с връзките на избраната същност.'
                }
              >
                <DataTable
                  columns={networkColumns}
                  rows={counterpartyRows(counterparties)}
                  // Key on the slug hrefs, not the display labels — two different entities can share a
                  // de-branded name and would otherwise collide (React key warning).
                  getKey={(r) => `${r.fromHref}-${r.toHref}`}
                  caption="Всички връзки"
                />
                {cpNav &&
                  (cpNav.pageCount === null
                    ? Boolean(counterparties.nextCursor || counterparties.prevCursor)
                    : cpNav.pageCount > 1) && (
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
