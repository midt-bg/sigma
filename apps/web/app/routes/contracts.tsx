import { Link, useSearchParams } from 'react-router';
import { count, date, money } from '@sigma/shared';
import { contractsSummary, getContractFacets, listContracts, type ContractSort } from '@sigma/db';
import type { Route } from './+types/contracts';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FilterRail, type FilterGroup } from '../components/FilterRail';
import { ListControls } from '../components/ListControls';
import { Pagination } from '../components/Pagination';
import { Callout } from '../components/ui';
import { getMulti, pageNav, withParams, PAGE_SIZE } from '../lib/filters';
import { publicCache } from '../lib/cache';

const VALUE_BUCKETS = [
  { value: 'lt100k', label: 'Под 100 хил. €' },
  { value: '100k-1m', label: '100 хил. – 1 млн. €' },
  { value: '1m-10m', label: '1 – 10 млн. €' },
  { value: '10m-100m', label: '10 – 100 млн. €' },
  { value: 'gt100m', label: 'Над 100 млн. €' },
];

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Договори — Сигма' },
    {
      name: 'description',
      content: 'Всеки сключен договор от обществена поръчка. Филтри в адреса; CSV експорт.',
    },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const params = {
    sort: (sp.get('sort') as ContractSort) || 'value-desc',
    years: getMulti(sp, 'year'),
    sectors: getMulti(sp, 'sector'),
    procedureGroups: getMulti(sp, 'procedure'),
    valueBucket: sp.get('value'),
    eu: (sp.get('eu') as 'eu' | 'national' | null) || null,
    authority: sp.get('authority'),
    bidder: sp.get('bidder'),
    cursor: sp.get('cursor'),
    pageSize: PAGE_SIZE.contracts,
  };
  const { env } = context.cloudflare;
  // Page `Cache-Control` (publicCache(1800)) memoises full responses at the edge — no per-query cache.
  const [summary, facets] = await Promise.all([
    contractsSummary(env.DB, params),
    getContractFacets(env.DB),
  ]);
  const result = await listContracts(env.DB, params, summary);
  return { result, facets };
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
  const filtered = sp.get('authority') || sp.get('bidder');

  const groups: FilterGroup[] = [
    {
      key: 'year',
      label: 'Година',
      type: 'checkbox',
      open: true,
      selected: getMulti(sp, 'year'),
      options: facets.years.map((y) => ({ value: y.value, label: y.label, count: y.count })),
    },
    {
      key: 'sector',
      label: 'Сектор (CPV)',
      type: 'checkbox',
      open: true,
      selected: getMulti(sp, 'sector'),
      options: facets.sectors.map((s) => ({ value: s.value, label: s.label, count: s.count })),
    },
    {
      key: 'procedure',
      label: 'Процедура',
      type: 'checkbox',
      selected: getMulti(sp, 'procedure'),
      options: facets.procedures.map((p) => ({ value: p.value, label: p.label, count: p.count })),
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
      label: 'ЕС финансиране',
      type: 'radio',
      selected: sp.get('eu') ? [sp.get('eu')!] : [],
      options: [
        { value: 'eu', label: 'Само с ЕС финансиране' },
        { value: 'national', label: 'Само без ЕС финансиране' },
      ],
    },
  ];

  const startRank = (nav.page - 1) * PAGE_SIZE.contracts;

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Договори' }]} />
      <main id="main">
        <PageHeader
          kicker={`${count(result.total)} договора`}
          title="Договори"
          lede="Всеки сключен договор от обществена поръчка. Всеки агрегат другаде на платформата — сума за институция, сума за компания, поток между двете — се разлага до точно този списък. Филтрите се запазват в адреса."
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
                Филтрирано по {sp.get('authority') ? 'институция' : 'компания'} ·{' '}
                <Link
                  to={withParams(sp, { authority: null, bidder: null, cursor: null, page: null })}
                >
                  изчисти
                </Link>
              </p>
            )}

            <div className="table-wrap tbl-cards">
              <table>
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 32 }}>
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
                          <span className="suspect">данните се преглеждат</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pagination nav={nav} pageSize={PAGE_SIZE.contracts} />

            <Callout title={'Какво е „договор“ в Сигма'}>
              <p style={{ margin: '0 0 6px' }}>
                Един възложен договор за обществена поръчка, на ниво обособена позиция (лот).
                Стойностите се показват в евро — изчистена, съпоставима стойност на договора.
              </p>
              <p style={{ margin: 0 }}>
                <strong>Брой оферти</strong> е броят на получените предложения по преписката; самите
                оферти и техните стойности не са в АОП и затова тук няма изглед „по оферент".
              </p>
            </Callout>
          </section>
        </div>
      </main>
    </>
  );
}
