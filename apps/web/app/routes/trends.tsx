import { Form, useNavigation, useSearchParams, useSubmit } from 'react-router';
import type { TrendYear } from '@sigma/api-contract';
import { count, money, pct, signedPct } from '@sigma/shared';
import { getSpendingTrend } from '@sigma/db';
import type { Route } from './+types/trends';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { DataTable, type Column } from '../components/DataTable';
import { TrendChart } from '../components/TrendChart';
import { Callout, Section } from '../components/ui';
import { publicCache } from '../lib/cache';
import { singleSelectFilters } from '../lib/filters';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Тренд във времето — СИГМА' },
    {
      name: 'description',
      content:
        'Как се движат разходите за обществени поръчки във времето, по месеци и години, със сезонните пикове. Изцяло върху наличните данни.',
    },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const { sector, funding, unknownSector } = singleSelectFilters(sp);
  const granularity = sp.get('g') === 'year' ? 'year' : 'month';
  const db = context.cloudflare.env.DB;
  const data = await getSpendingTrend(db, { sector, funding, granularity });
  return { data, unknownSector };
}

export default function Trends({ loaderData }: Route.ComponentProps) {
  const { data, unknownSector } = loaderData;
  const [sp] = useSearchParams();
  const submit = useSubmit();
  const navigating = useNavigation().state !== 'idle';
  const sel = (k: string) => sp.get(k) ?? '';

  const yearColumns: Column<TrendYear>[] = [
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

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Тренд във времето' }]} />
      <main id="main">
        <PageHeader
          kicker="Анализ"
          title="Тренд във времето"
          lede="Как се движат разходите за обществени поръчки през годините. Месечната графика показва обема и типичните пикове в края на годината. Договорите без валидна дата на сключване не влизат в графиката."
        />

        <Form
          method="get"
          className="flow-controls"
          role="group"
          aria-label="Филтри на тренда"
          onChange={(e) => submit(e.currentTarget)}
        >
          <label>
            Стъпка:
            <select name="g" defaultValue={sel('g')}>
              <option value="">Месечно</option>
              <option value="year">Годишно</option>
            </select>
          </label>
          <label>
            Сектор:
            <select name="sector" defaultValue={unknownSector ? '' : sel('sector')}>
              <option value="">Всички сектори</option>
              {data.sectors.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.short}
                </option>
              ))}
            </select>
          </label>
          <label>
            Финансиране:
            <select name="funding" defaultValue={sel('funding')}>
              <option value="">Всякакво</option>
              <option value="eu">Само с финансиране от ЕС</option>
              <option value="national">Само без финансиране от ЕС</option>
            </select>
          </label>
          <noscript>
            <button type="submit">Покажи</button>
          </noscript>
        </Form>

        <p className="sr-only" role="status">
          {navigating ? 'Обновяване на визуализацията…' : 'Визуализацията е обновена.'}
        </p>

        {unknownSector && (
          <Callout variant="warning" title="Непознат филтър">
            <p style={{ margin: 0 }}>Избраният сектор не съществува. Показваме всички сектори.</p>
          </Callout>
        )}

        <Section
          id="chart"
          title={`Разходи по ${data.granularity === 'year' ? 'години' : 'месеци'}`}
          hint={`Общо ${money(data.totalValueEur)} за периода.`}
        >
          {data.points.length >= 2 ? (
            <TrendChart points={data.points} granularity={data.granularity} />
          ) : (
            <p className="muted">Няма достатъчно данни за избраните филтри.</p>
          )}
        </Section>

        <Section
          id="years"
          title="По години"
          hint="Сумарно за всяка година и промяната спрямо предходната."
        >
          <DataTable
            columns={yearColumns}
            rows={data.years}
            getKey={(r) => r.year}
            caption="Разходи по години"
          />
        </Section>

        <Callout title="За покритието на данните">
          <p style={{ margin: 0 }}>
            Графиката включва договорите с валидна дата на сключване ({pct(data.coverage.pct)} от
            тях). Последният период е непълен и е отбелязан като „частично". Виж методологията за
            подробности.
          </p>
        </Callout>
      </main>
    </>
  );
}
