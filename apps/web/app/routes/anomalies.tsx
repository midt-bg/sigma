import { Link, useNavigation, useSearchParams } from 'react-router';
import { count, date, money } from '@sigma/shared';
import { getAnomalyFacets, listAnomalies, type AnomalySort } from '@sigma/db';
import type { AnomalyListItem } from '@sigma/api-contract';
import type { Route } from './+types/anomalies';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FilterRail, type FilterGroup } from '../components/FilterRail';
import { ListControls } from '../components/ListControls';
import { Pagination } from '../components/Pagination';
import { Callout, Flag } from '../components/ui';
import { anomalyBadges } from '../lib/anomaly-badges';
import {
  buildSectorGroup,
  getMulti,
  leaderboardRankOffset,
  pageNav,
  withParams,
  PAGE_SIZE,
} from '../lib/filters';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';

const VALUE_BUCKETS = [
  { value: 'lt100k', label: 'Под 100 хил. €' },
  { value: '100k-1m', label: '100 хил. – 1 млн. €' },
  { value: '1m-10m', label: '1 – 10 млн. €' },
  { value: '10m-100m', label: '10 – 100 млн. €' },
  { value: 'gt100m', label: 'Над 100 млн. €' },
];

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Аномалии — СИГМА' },
    {
      name: 'description',
      content:
        'Автоматични проверки на цените по обществени поръчки: договори над прогнозата, раснали чрез анекси или далеч над типичното за сектора.',
    },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const params = {
    sort: (sp.get('sort') as AnomalySort) || 'score-desc',
    signals: getMulti(sp, 'signal'),
    years: getMulti(sp, 'year'),
    sectors: getMulti(sp, 'sector'),
    valueBucket: sp.get('value'),
    authority: sp.get('authority'),
    bidder: sp.get('bidder'),
    cursor: sp.get('cursor'),
    pageSize: PAGE_SIZE.anomalies,
  };
  const { env } = context.cloudflare;
  return withDbRetry(async () => {
    const [result, facets] = await Promise.all([
      listAnomalies(env.DB, params),
      getAnomalyFacets(env.DB),
    ]);
    return { result, facets };
  });
}

// The fired signals as red-flag chips. The mapping/copy lives in lib/anomaly-badges (unit tested);
// each chip carries its numbers inline, so a row is verifiable at a glance without opening the
// contract.
function SignalFlags({ item }: { item: AnomalyListItem }) {
  const badges = anomalyBadges(item.signals);
  if (badges.length === 0) return null;
  return (
    <span className="signal-flags">
      {badges.map((b) => (
        <Flag key={b.key} variant={b.context ? 'soft' : undefined}>
          {b.label}
          {b.detail && <span className="flag-detail"> {b.detail}</span>}
        </Flag>
      ))}
    </span>
  );
}

export default function Anomalies({ loaderData }: Route.ComponentProps) {
  const { result, facets } = loaderData;
  const [sp] = useSearchParams();
  const sort = sp.get('sort') ?? 'score-desc';
  const nav = pageNav({
    base: sp,
    total: result.total,
    pageSize: PAGE_SIZE.anomalies,
    nextCursor: result.nextCursor,
    prevCursor: result.prevCursor,
  });
  const busy = useNavigation().state !== 'idle';

  const groups: FilterGroup[] = [
    {
      key: 'signal',
      label: 'Сигнал',
      type: 'checkbox',
      selected: getMulti(sp, 'signal'),
      options: facets.signals.map((s) => ({ value: s.value, label: s.label, count: s.count })),
    },
    buildSectorGroup(
      facets.sectors.map((s) => ({ value: s.value, label: s.label, count: s.count })),
      getMulti(sp, 'sector'),
    ),
    {
      key: 'year',
      label: 'Година',
      type: 'checkbox',
      selected: getMulti(sp, 'year'),
      options: facets.years.map((y) => ({ value: y.value, label: y.label, count: y.count })),
    },
    {
      key: 'value',
      label: 'Стойност (в евро)',
      type: 'radio',
      selected: sp.get('value') ? [sp.get('value')!] : [],
      options: VALUE_BUCKETS,
    },
  ];

  const startRank = leaderboardRankOffset(nav.page, PAGE_SIZE.anomalies);

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Аномалии' }]} />
      <main id="main">
        <PageHeader
          kicker={`${count(result.total)} договора със сигнал`}
          title="Аномалии"
          lede="Автоматични проверки върху всеки договор: подписан над прогнозата на самия възложител, раснал след подписването чрез анекси или далеч над типичната стойност за същия CPV код. Сигналът е индикатор за проверка, не присъда — всяко число е проследимо до конкретния договор."
        />

        <div className="split">
          <FilterRail groups={groups} sort={sort} clearHref="/anomalies" />
          <section>
            <ListControls
              base={sp}
              activeSort={sort}
              sorts={[
                { value: 'score-desc', label: 'риск ↓' },
                { value: 'value-desc', label: 'стойност ↓' },
                { value: 'value-asc', label: 'стойност ↑' },
                { value: 'date-desc', label: 'нови' },
              ]}
              count={
                <>
                  Намерени <strong>{count(result.total)}</strong> договора ·{' '}
                  <strong>{money(result.valueEur)}</strong>
                </>
              }
            />

            {result.items.length === 0 ? (
              <p className="muted">
                Няма резултати за избраните филтри. <Link to="/anomalies">Изчисти филтрите</Link>
              </p>
            ) : (
              <div className="table-wrap tbl-cards" aria-busy={busy || undefined}>
                <table>
                  <caption className="sr-only">
                    Договори с автоматични сигнали за ценови аномалии
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" style={{ width: 32 }}>
                        #
                      </th>
                      <th scope="col">Договор · Сигнали</th>
                      <th scope="col">Възложител · Изпълнител</th>
                      <th scope="col" className="col-secondary">
                        Дата
                      </th>
                      <th scope="col" className="num">
                        Стойност · Риск
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items.map((c, i) => (
                      <tr className="contract-row" key={c.id}>
                        <td className="rank cell-rank" data-label="#">
                          {startRank + i + 1}
                        </td>
                        <td className="subj cell-title" data-label="Договор · Сигнали">
                          <Link className="title" to={`/contracts/${c.id}`}>
                            {c.subject}
                          </Link>
                          <span className="unp">
                            УНП {c.unp}
                            {c.isConsortium ? ' · обединение' : ''}
                          </span>
                          <SignalFlags item={c} />
                        </td>
                        <td className="parties" data-label="Възложител · Изпълнител">
                          <span className="from">
                            <Link to={`/authorities/${c.authoritySlug}`}>{c.authorityName}</Link>{' '}
                            <span className="who">възложител</span>
                          </span>
                          <span className="to">
                            <Link to={`/companies/${c.bidderSlug}`}>{c.bidderDisplayName}</Link>{' '}
                            <span className="who">изпълнител</span>
                          </span>
                        </td>
                        <td className="meta col-secondary" data-label="Дата">
                          {date(c.signedAt)}
                        </td>
                        <td className="money" data-label="Стойност · Риск">
                          {money(c.valueEur)}
                          <br />
                          <span className="score">
                            {c.score}
                            <span className="of">/100</span>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {result.items.length > 0 && <Pagination nav={nav} pageSize={PAGE_SIZE.anomalies} />}

            <Callout>
              <h2
                style={{
                  font: '400 18px/1.25 var(--font-serif)',
                  letterSpacing: '-0.01em',
                  color: 'var(--ink, #111)',
                  marginBottom: 6,
                }}
              >
                Как се изчисляват сигналите
              </h2>
              <p style={{ margin: 0 }}>
                Три ценови сигнала поставят договор в този списък: подписан ≥ 10% над прогнозата на
                възложителя, ръст ≥ 20% чрез анекси или стойност ≥ 5 пъти над медианата на договорите
                със същия CPV код. „Единствена оферта“ и „без обявление“ добавят точки към риска, но
                сами по себе си не са аномалия. Праговете, изключенията и ограниченията са описани в{' '}
                <Link to="/methodology#flags">методологията</Link>.
              </p>
            </Callout>
          </section>
        </div>
      </main>
    </>
  );
}
