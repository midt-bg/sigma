import { Link, useNavigation, useSearchParams } from 'react-router';
import { count, date, money } from '@sigma/shared';
import {
  contractsSummary,
  getContractFacets,
  listContracts,
  normalizeContractSort,
} from '@sigma/db';
import type { Route } from './+types/contracts';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FilterRail, type FilterGroup } from '../components/FilterRail';
import { ListControls } from '../components/ListControls';
import { Pagination } from '../components/Pagination';
import { Callout } from '../components/ui';
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
    { title: 'Договори — СИГМА' },
    {
      name: 'description',
      content:
        'Всеки сключен договор по обществена поръчка. Филтрите са в адреса, има и сваляне в CSV.',
    },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const params = {
    sort: normalizeContractSort(sp.get('sort')),
    years: getMulti(sp, 'year'),
    sectors: getMulti(sp, 'sector'),
    procedureGroups: getMulti(sp, 'procedure'),
    valueBucket: sp.get('value'),
    eu: (sp.get('eu') as 'eu' | 'national' | null) || null,
    authority: sp.get('authority'),
    bidder: sp.get('bidder'),
    q: sp.get('q'),
    bids: (sp.get('bids') === '1' ? 'one' : null) as 'one' | null,
    cursor: sp.get('cursor'),
    pageSize: PAGE_SIZE.contracts,
  };
  const { env } = context.cloudflare;
  // Page `Cache-Control` (publicCache(1800)) memoises full responses at the edge — no per-query cache.
  return withDbRetry(async () => {
    const [summary, facets] = await Promise.all([
      contractsSummary(env.DB, params),
      getContractFacets(env.DB),
    ]);
    const result = await listContracts(env.DB, params, summary);
    return { result, facets };
  });
}

export default function Contracts({ loaderData }: Route.ComponentProps) {
  const { result, facets } = loaderData;
  const [sp] = useSearchParams();
  const sort = sp.get('sort') ?? 'value-desc';
  const nav = pageNav({
    base: sp,
    total: result.total,
    pageSize: PAGE_SIZE.contracts,
    nextCursor: result.nextCursor,
    prevCursor: result.prevCursor,
  });
  const csvHref = `/contracts.csv${withParams(sp, { cursor: null, page: null })}`;
  const fAuthority = sp.get('authority');
  const fBidder = sp.get('bidder');
  const filtered = fAuthority || fBidder;
  // A filtered view shares one authority/bidder across every row, so the name is taken from the
  // first result (null when the filter combined with others yields no rows — then show the label only).
  const filterAuthorityName = fAuthority ? (result.items[0]?.authorityName ?? null) : null;
  const filterBidderName = fBidder ? (result.items[0]?.bidderDisplayName ?? null) : null;
  const busy = useNavigation().state !== 'idle';

  const groups: FilterGroup[] = [
    buildSectorGroup(
      facets.sectors.map((s) => ({ value: s.value, label: s.label, count: s.count })),
      getMulti(sp, 'sector'),
    ),
    {
      key: 'procedure',
      label: 'Процедура',
      type: 'checkbox',
      selected: getMulti(sp, 'procedure'),
      options: facets.procedures.map((p) => ({ value: p.value, label: p.label, count: p.count })),
    },
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
    {
      key: 'eu',
      label: 'Финансиране от ЕС',
      type: 'radio',
      selected: sp.get('eu') ? [sp.get('eu')!] : [],
      options: [
        { value: 'eu', label: 'Само с финансиране от ЕС' },
        { value: 'national', label: 'Само без финансиране от ЕС' },
      ],
    },
  ];

  const startRank = leaderboardRankOffset(nav.page, PAGE_SIZE.contracts);

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Договори' }]} />
      <main id="main">
        <PageHeader
          kicker={`${count(result.total)} договора`}
          title="Договори"
          lede="Всеки сключен договор по обществена поръчка. Всяко обобщение другаде в платформата — обща сума за институция, за компания или поток между двете — се свежда точно до този списък. Филтрите остават в адреса."
        />

        <div className="split">
          <FilterRail groups={groups} sort={sort} clearHref="/contracts" csvHref={csvHref} />
          <section>
            <ListControls
              base={sp}
              activeSort={sort}
              sorts={[
                { value: 'date-desc', label: 'нови' },
                { value: 'date-asc', label: 'стари' },
                { value: 'value-desc', label: 'стойност ↓' },
                { value: 'value-asc', label: 'стойност ↑' },
              ]}
              count={
                <>
                  Намерени <strong>{count(result.total)}</strong> договора ·{' '}
                  <strong>{money(result.valueEur)}</strong>
                  {result.suspect > 0 && (
                    <>
                      {' '}
                      · <span className="suspect">{result.suspect} с непотвърдена стойност</span>
                    </>
                  )}
                </>
              }
            />

            {filtered && (
              <p className="active-filters">
                Филтрирано по{' '}
                {fAuthority && (
                  <>
                    институция
                    {filterAuthorityName ? (
                      <>
                        {' '}
                        <strong>{filterAuthorityName}</strong>
                      </>
                    ) : null}
                  </>
                )}
                {fAuthority && fBidder ? ' и ' : ''}
                {fBidder && (
                  <>
                    компания
                    {filterBidderName ? (
                      <>
                        {' '}
                        <strong>{filterBidderName}</strong>
                      </>
                    ) : null}
                  </>
                )}{' '}
                ·{' '}
                <Link
                  to={withParams(sp, { authority: null, bidder: null, cursor: null, page: null })}
                >
                  изчисти
                </Link>
              </p>
            )}

            {result.items.length === 0 ? (
              <p className="muted">
                Няма резултати за избраните филтри. <Link to="/contracts">Изчисти филтрите</Link>
              </p>
            ) : (
              <div className="table-wrap tbl-cards" aria-busy={busy || undefined}>
                <table>
                  <caption className="sr-only">Договори по обществени поръчки</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="col-w-32">
                        #
                      </th>
                      <th scope="col">Договор</th>
                      <th scope="col">Възложител · Изпълнител</th>
                      <th scope="col" className="col-secondary">
                        Процедура · Дата
                      </th>
                      <th scope="col" className="num">
                        Стойност
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items.map((c, i) => (
                      <tr className="contract-row" key={c.id}>
                        <td className="rank cell-rank" data-label="#">
                          {startRank + i + 1}
                        </td>
                        <td className="subj cell-title" data-label="Договор">
                          <Link className="title" to={`/contracts/${c.id}`}>
                            {c.subject}
                          </Link>
                          {c.euFunded && <span className="eu">ЕС</span>}
                          <span className="unp">
                            УНП {c.unp}
                            {c.isConsortium ? ' · обединение' : ''}
                          </span>
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
                        <td className="meta col-secondary" data-label="Процедура · Дата">
                          <span className="pr">{c.procedureLabel}</span>
                          <br />
                          {date(c.signedAt)}
                        </td>
                        <td className="money" data-label="Стойност">
                          {c.valueEur != null ? (
                            money(c.valueEur)
                          ) : (
                            <span className="suspect">данните се проверяват</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {result.items.length > 0 && <Pagination nav={nav} pageSize={PAGE_SIZE.contracts} />}

            <Callout>
              <h2>Какво е „договор“ в СИГМА</h2>
              <p className="m-0">
                Един възложен договор по обществена поръчка, на ниво обособена позиция (лот).
                Стойностите са в евро — изчистена, съпоставима стойност на договора.
              </p>
            </Callout>
          </section>
        </div>
      </main>
    </>
  );
}
