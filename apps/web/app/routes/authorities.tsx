import { useNavigation, useSearchParams } from 'react-router';
import { Link } from '../i18n/Link';
import { count, moneyBare, plural } from '@sigma/shared';
import { useTranslation, useLocale } from '../i18n/context';
import { makeT } from '../i18n/t';
import { getLocale } from '../i18n/locale';
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
import { seoMeta } from '../lib/meta';

export function meta({ location, matches }: Route.MetaArgs) {
  const t = makeT(getLocale(location.pathname));
  return seoMeta({
    matches,
    path: '/authorities',
    title: t('authorities.metaTitle'),
    description: t('authorities.metaDescription'),
  });
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
  const locale = getLocale(request);
  const db = context.cloudflare.env.DB;
  const [page, facets, coverage] = await Promise.all([
    listAuthorities(db, params, locale),
    getAuthorityFacets(db, locale),
    getCoverageMeta(db),
  ]);
  return { page, facets, coverage };
}

export default function Authorities({ loaderData }: Route.ComponentProps) {
  const { page, facets, coverage } = loaderData;
  const t = useTranslation();
  const locale = useLocale();
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
      label: t('authorities.filterType'),
      type: 'checkbox',
      selected: getMulti(sp, 'type'),
      options: facets.types.map((ty) => ({ value: ty.value, label: ty.label, count: ty.count })),
    },
    buildSectorGroup(
      facets.sectors.map((s) => ({ value: s.value, label: s.label })),
      getMulti(sp, 'sector'),
      locale,
    ),
    {
      key: 'year',
      label: t('authorities.filterYear'),
      type: 'checkbox',
      selected: getMulti(sp, 'year'),
      options: yearOptions(coverage.coverageEndYear).map((y) => ({
        value: y,
        label: y,
      })),
    },
    {
      key: 'eu',
      label: t('authorities.filterEu'),
      type: 'radio',
      selected: sp.get('eu') ? [sp.get('eu')!] : [],
      options: [
        { value: 'eu', label: t('authorities.filterEuOnly') },
        { value: 'national', label: t('authorities.filterEuNone') },
      ],
    },
  ];

  const columns: Column<AuthorityListItem>[] = [
    { key: 'rank', header: '#', isRank: true, cell: (_r, i) => startRank + i + 1 },
    {
      key: 'name',
      header: t('authorities.colName'),
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
      header: t('authorities.colType'),
      secondary: true,
      cell: (a) => (a.typeLabel ? <Chip>{a.typeLabel}</Chip> : null),
    },
    {
      key: 'spent',
      header: t('authorities.colSpent'),
      align: 'money',
      cell: (a) => moneyBare(a.spentEur, locale),
    },
    {
      key: 'contracts',
      header: t('authorities.colContracts'),
      align: 'money',
      cell: (a) => count(a.contracts, locale),
    },
    {
      key: 'avg',
      header: t('authorities.colAvg'),
      align: 'money',
      cell: (a) => moneyBare(a.avgEur, locale),
    },
  ];

  return (
    <>
      <Breadcrumbs
        items={[
          { label: t('authorities.breadcrumbHome'), to: '/' },
          { label: t('authorities.breadcrumbAuthorities') },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker={t('authorities.kicker', { count: count(page.total, locale) })}
          title={t('authorities.title')}
          lede={t('authorities.lede')}
        />
        <div className="split">
          <FilterRail groups={groups} sort={sort} clearHref="/authorities" csvHref={csvHref} />
          <section>
            <ListControls
              base={sp}
              activeSort={sort}
              sorts={[
                { value: 'spent', label: t('authorities.sortSpent') },
                { value: 'count', label: t('authorities.sortCount') },
                { value: 'avg', label: t('authorities.sortAvg') },
                { value: 'name', label: t('authorities.sortName') },
              ]}
              count={
                <>
                  {t('authorities.shownPrefix')} <strong>{page.items.length}</strong>{' '}
                  {t('authorities.shownMiddle')} <strong>{count(page.total, locale)}</strong>{' '}
                  {plural(
                    page.total,
                    t('authorities.shownUnit_one'),
                    t('authorities.shownUnit_many'),
                    locale,
                  )}
                </>
              }
            />
            {page.items.length === 0 ? (
              <p className="muted">
                {t('authorities.emptyState')}{' '}
                <Link to="/authorities">{t('authorities.clearFilters')}</Link>
              </p>
            ) : (
              <div aria-busy={busy || undefined}>
                <DataTable
                  columns={columns}
                  rows={page.items}
                  getKey={(a) => a.slug}
                  caption={t('authorities.tableCaption')}
                />
              </div>
            )}
            {page.items.length > 0 && <Pagination nav={nav} pageSize={PAGE_SIZE.authorities} />}
            <Callout>
              <h2>{t('authorities.calloutTitle')}</h2>
              <p className="m-0">
                {t('authorities.calloutBodyPre', { range })}{' '}
                <Link to="/methodology">{t('authorities.methodologyLink')}</Link>
                {t('authorities.calloutBodyPost')}
              </p>
            </Callout>
          </section>
        </div>
      </main>
    </>
  );
}
