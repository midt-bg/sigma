import { useNavigation, useSearchParams } from 'react-router';
import { Link } from '../i18n/Link';
import { count, money, moneyBare, parseConsortiumMembers, plural } from '@sigma/shared';
import { useTranslation, useLocale } from '../i18n/context';
import { makeT, type TFunction } from '../i18n/t';
import { getLocale } from '../i18n/locale';
import { getCompanyFacets, listCompanies } from '@sigma/db';
import type { CompanyListItem } from '@sigma/api-contract';
import type { Route } from './+types/companies';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FilterRail, type FilterGroup } from '../components/FilterRail';
import { ListControls } from '../components/ListControls';
import { Pagination } from '../components/Pagination';
import { DataTable, type Column } from '../components/DataTable';
import { Callout, Chip, OwnershipChip } from '../components/ui';
import {
  buildSectorGroup,
  companyListParams,
  getMulti,
  leaderboardRankOffset,
  pageNav,
  withParams,
  PAGE_SIZE,
} from '../lib/filters';
import { publicCache } from '../lib/cache';
import { getCoverageMeta, yearOptions } from '../lib/coverage';
import { seoMeta } from '../lib/meta';

export function meta({ location, matches }: Route.MetaArgs) {
  const t = makeT(getLocale(location.pathname));
  return seoMeta({
    matches,
    path: '/companies',
    title: t('companies.metaTitle'),
    description: t('companies.metaDescription'),
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const params = {
    ...companyListParams(sp),
    q: sp.get('q'),
    cursor: sp.get('cursor'),
    pageSize: PAGE_SIZE.companies,
  };
  const locale = getLocale(request);
  const db = context.cloudflare.env.DB;
  const [page, facets, coverage] = await Promise.all([
    listCompanies(db, params, locale),
    getCompanyFacets(db, locale),
    getCoverageMeta(db),
  ]);
  return { page, facets, coverage };
}

function subtitle(c: CompanyListItem, t: TFunction) {
  const place = c.settlement ? ` · ${c.settlement}` : '';
  if (c.isConsortium) {
    const parsed = parseConsortiumMembers(c.name);
    const members = parsed?.kind === 'list' ? parsed.members.length : null;
    return members
      ? t('companies.members', { count: members, place })
      : t('companies.union', { place });
  }
  return c.hasEik && c.eik
    ? t('companies.eik', { eik: c.eik, place })
    : `${t('companies.noEik')}${place}`;
}

export default function Companies({ loaderData }: Route.ComponentProps) {
  const { page, facets, coverage } = loaderData;
  const t = useTranslation();
  const locale = useLocale();
  const [sp] = useSearchParams();
  const COUNT_BUCKETS = [
    { value: '1', label: t('companies.bucket1') },
    { value: '2-5', label: '2–5' },
    { value: '6-20', label: '6–20' },
    { value: '21-100', label: '21–100' },
    { value: '100+', label: '100+' },
  ];
  const sort = sp.get('sort') ?? 'won';
  const nav = pageNav({
    base: sp,
    total: page.total,
    pageSize: PAGE_SIZE.companies,
    nextCursor: page.nextCursor,
    prevCursor: page.prevCursor,
  });
  const startRank = leaderboardRankOffset(nav.page, PAGE_SIZE.companies);
  const csvHref = `/companies.csv${withParams(sp, { cursor: null, page: null })}`;
  const busy = useNavigation().state !== 'idle';

  const groups: FilterGroup[] = [
    buildSectorGroup(
      facets.sectors.map((s) => ({ value: s.value, label: s.label })),
      getMulti(sp, 'sector'),
      locale,
    ),
    {
      key: 'kind',
      label: t('companies.filterKind'),
      type: 'checkbox',
      selected: getMulti(sp, 'kind'),
      options: facets.kinds.map((k) => ({ value: k.value, label: k.label, count: k.count })),
    },
    {
      key: 'count',
      label: t('companies.filterCount'),
      type: 'radio',
      selected: sp.get('count') ? [sp.get('count')!] : [],
      options: COUNT_BUCKETS,
    },
    {
      key: 'year',
      label: t('companies.filterYear'),
      type: 'checkbox',
      selected: getMulti(sp, 'year'),
      options: yearOptions(coverage.coverageEndYear).map((y) => ({
        value: y,
        label: y,
      })),
    },
    {
      key: 'eu',
      label: t('companies.filterEu'),
      type: 'radio',
      selected: sp.get('eu') ? [sp.get('eu')!] : [],
      options: [
        { value: 'eu', label: t('companies.filterEuOnly') },
        { value: 'national', label: t('companies.filterEuNone') },
      ],
    },
  ];

  const columns: Column<CompanyListItem>[] = [
    { key: 'rank', header: '#', isRank: true, cell: (_r, i) => startRank + i + 1 },
    {
      key: 'name',
      header: t('companies.colName'),
      isTitle: true,
      cell: (c) => (
        <>
          <Link to={`/companies/${c.slug}`}>{c.displayName}</Link>
          <br />
          <span className="small muted">{subtitle(c, t)}</span>
        </>
      ),
    },
    {
      key: 'type',
      header: t('companies.colType'),
      secondary: true,
      cell: (c) => (
        <>
          <Chip>{c.isConsortium ? t('companies.consortium') : t('companies.company')}</Chip>
          {!c.isConsortium && !c.hasEik && (
            <>
              {' '}
              <Chip>{t('companies.noEik')}</Chip>
            </>
          )}
          {c.ownershipKind && (
            <>
              {' '}
              <OwnershipChip kind={c.ownershipKind} />
            </>
          )}
        </>
      ),
    },
    {
      key: 'won',
      header: t('companies.colWon'),
      align: 'money',
      cell: (c) => moneyBare(c.wonEur, locale),
    },
    {
      key: 'contracts',
      header: t('companies.colContracts'),
      align: 'money',
      cell: (c) => count(c.contracts, locale),
    },
    {
      key: 'authorities',
      header: t('companies.colAuthorities'),
      align: 'money',
      cell: (c) => count(c.authorities, locale),
    },
  ];

  return (
    <>
      <Breadcrumbs
        items={[
          { label: t('companies.breadcrumbHome'), to: '/' },
          { label: t('companies.breadcrumbCompanies') },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker={t('companies.kicker', { count: count(page.total, locale) })}
          title={t('companies.title')}
          lede={t('companies.lede')}
        />
        <div className="split">
          <FilterRail groups={groups} sort={sort} clearHref="/companies" csvHref={csvHref} />
          <section>
            <ListControls
              base={sp}
              activeSort={sort}
              sorts={[
                { value: 'won', label: t('companies.sortWon') },
                { value: 'count', label: t('companies.sortCount') },
                { value: 'authorities', label: t('companies.sortAuthorities') },
                { value: 'name', label: t('companies.sortName') },
              ]}
              count={
                <>
                  {t('companies.shownPrefix')} <strong>{page.items.length}</strong>{' '}
                  {t('companies.shownMiddle')} <strong>{count(page.total, locale)}</strong>{' '}
                  {plural(
                    page.total,
                    t('companies.shownUnit_one'),
                    t('companies.shownUnit_many'),
                    locale,
                  )}
                </>
              }
            />
            {page.items.length === 0 ? (
              <p className="muted">
                {t('companies.emptyState')}{' '}
                <Link to="/companies">{t('companies.clearFilters')}</Link>
              </p>
            ) : (
              <div aria-busy={busy || undefined}>
                <DataTable
                  columns={columns}
                  rows={page.items}
                  getKey={(c) => c.slug}
                  caption={t('companies.tableCaption')}
                />
              </div>
            )}
            {page.items.length > 0 && <Pagination nav={nav} pageSize={PAGE_SIZE.companies} />}
            <Callout>
              <h2>{t('companies.calloutTitle')}</h2>
              <p className="m-0">{t('companies.calloutBody')}</p>
            </Callout>
          </section>
        </div>
      </main>
    </>
  );
}
