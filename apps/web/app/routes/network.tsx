import { Form, Link, useNavigation, useSubmit } from 'react-router';
import { getEntityNetwork } from '@sigma/db';
import type { Route } from './+types/network';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
import { NetworkGraph } from '../components/NetworkGraph';
import { Callout, Section } from '../components/ui';
import { publicCache } from '../lib/cache';
import { centerToken, parseCenter } from '../lib/network-center';
import { networkColumns, networkRows } from '../lib/entity-tables';

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
  const center = parseCenter(new URL(request.url).searchParams.get('center'));
  const data = await getEntityNetwork(context.cloudflare.env.DB, center);
  // A well-formed but non-existent ?center should 404 like the other entity pages, not render an
  // empty 200 that then gets edge-cached. A missing or malformed ?center keeps the default centre.
  if (center && !data.center) {
    throw new Response('Not Found', { status: 404 });
  }
  return { data };
}

export default function Network({ loaderData }: Route.ComponentProps) {
  const { data } = loaderData;
  const submit = useSubmit();
  const navigating = useNavigation().state !== 'idle';
  const centerValue = data.center ? centerToken(data.center) : '';

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
                columns={networkColumns}
                rows={networkRows(data)}
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
