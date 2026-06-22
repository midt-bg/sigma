import { Link, useNavigation, useSearchParams } from 'react-router';
import { count, money } from '@sigma/shared';
import { getAuthorityFacets, listAuthorities, normalizeAuthoritySort } from '@sigma/db';
import type { AuthorityListItem } from '@sigma/api-contract';
import type { Route } from './+types/authorities';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FilterRail, type FilterGroup } from '../components/FilterRail';
import { ListControls } from '../components/ListControls';
import { Pagination } from '../components/Pagination';
import { DataTable, type Column } from '../components/DataTable';
import { Callout, Chip } from '../components/ui';
import {
  buildSectorGroup,
  getMulti,
  leaderboardRankOffset,
  pageNav,
  withParams,
  PAGE_SIZE,
} from '../lib/filters';
import { publicCache } from '../lib/cache';
import { coverageRange, getCoverageMeta, yearOptions } from '../lib/coverage';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Институции — СИГМА' },
    { name: 'description', content: 'Всяка институция, възложила поне един договор.' },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const params = {
    sort: normalizeAuthoritySort(sp.get('sort')),
    types: getMulti(sp, 'type'),
    sectors: getMulti(sp, 'sector'),
    years: getMulti(sp, 'year'),
    eu: (sp.get('eu') as 'eu' | 'national' | null) || null,
    q: sp.get('q'),
    cursor: sp.get('cursor'),
    pageSize: PAGE_SIZE.authorities,
  };
  const db = context.cloudflare.env.DB;
  const [page, facets, coverage] = await Promise.all([
    listAuthorities(db, params),
    getAuthorityFacets(db),
    getCoverageMeta(db),
  ]);
  return { page, facets, coverage };
}

export default function Authorities({ loaderData }: Route.ComponentProps) {
  const { page, facets, coverage } = loaderData;
  const range = coverageRange(coverage.coverageEndYear);
  const [sp] = useSearchParams();
  const sort = sp.get('sort') ?? 'spent';
  const nav = pageNav({
    base: sp,
    total: page.total,
    pageSize: PAGE_SIZE.authorities,
    nextCursor: page.nextCursor,
    prevCursor: page.prevCursor,
  });
  const startRank = leaderboardRankOffset(nav.page, PAGE_SIZE.authorities);
  const csvHref = `/authorities.csv${withParams(sp, { cursor: null, page: null })}`;
  const busy = useNavigation().state !== 'idle';

  const groups: FilterGroup[] = [
    {
      key: 'type',
      label: 'Вид институция',
      type: 'checkbox',
      selected: getMulti(sp, 'type'),
      options: facets.types.map((t) => ({ value: t.value, label: t.label, count: t.count })),
    },
    buildSectorGroup(
      facets.sectors.map((s) => ({ value: s.value, label: s.label })),
      getMulti(sp, 'sector'),
    ),
    {
      key: 'year',
      label: 'Година',
      type: 'checkbox',
      selected: getMulti(sp, 'year'),
      options: yearOptions(coverage.coverageEndYear).map((y) => ({
        value: y,
        label: y,
      })),
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

  const columns: Column<AuthorityListItem>[] = [
    { key: 'rank', header: '#', isRank: true, cell: (_r, i) => startRank + i + 1 },
    {
      key: 'name',
      header: 'Институция',
      isTitle: true,
      cell: (a) => (
        <>
          <Link to={`/authorities/${a.slug}`}>{a.name}</Link>
          {a.settlement && (
            <>
              <br />
              <span className="small muted">{a.settlement}</span>
            </>
          )}
        </>
      ),
    },
    {
      key: 'type',
      header: 'Вид',
      secondary: true,
      cell: (a) => (a.typeLabel ? <Chip>{a.typeLabel}</Chip> : null),
    },
    { key: 'spent', header: 'Похарчено', align: 'money', cell: (a) => money(a.spentEur) },
    { key: 'contracts', header: 'Договори', align: 'money', cell: (a) => count(a.contracts) },
    { key: 'avg', header: 'Средна стойност', align: 'money', cell: (a) => money(a.avgEur) },
  ];

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Институции' }]} />
      <main id="main">
        <PageHeader
          kicker={`${count(page.total)} възложители`}
          title="Институции"
          lede="Всяка институция, възложила поне един договор. Подреди ги по общо похарчено, по брой договори или по средна стойност. Филтрите остават в адреса."
        />
        <div className="split">
          <FilterRail groups={groups} sort={sort} clearHref="/authorities" csvHref={csvHref} />
          <section>
            <ListControls
              base={sp}
              activeSort={sort}
              sorts={[
                { value: 'spent', label: 'похарчено' },
                { value: 'count', label: 'договори' },
                { value: 'avg', label: 'средна' },
                { value: 'name', label: 'име' },
              ]}
              count={
                <>
                  Показани са <strong>{page.items.length}</strong> от{' '}
                  <strong>{count(page.total)}</strong> институции
                </>
              }
            />
            {page.items.length === 0 ? (
              <p className="muted">
                Няма резултати за избраните филтри. <Link to="/authorities">Изчисти филтрите</Link>
              </p>
            ) : (
              <div aria-busy={busy || undefined}>
                <DataTable
                  columns={columns}
                  rows={page.items}
                  getKey={(a) => a.slug}
                  caption="Институции по похарчено"
                />
              </div>
            )}
            {page.items.length > 0 && <Pagination nav={nav} pageSize={PAGE_SIZE.authorities} />}
            <Callout>
              <h2>Какво означава „похарчено“?</h2>
              <p className="m-0">
                Сумата от стойностите (в евро) на всички договори на дадена институция за периода{' '}
                {range}. Видът на институцията (министерство, община, болница…) се определя по името
                ѝ и е приблизителен. Виж <Link to="/methodology">методология</Link>.
              </p>
            </Callout>
          </section>
        </div>
      </main>
    </>
  );
}
