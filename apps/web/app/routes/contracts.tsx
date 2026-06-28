import { useNavigation, useSearchParams } from 'react-router';
import { Link } from '../i18n/Link';
import { count, date, money, moneyBare, plural } from '@sigma/shared';
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
import { seoMeta } from '../lib/meta';
import { useTranslation, useLocale } from '../i18n/context';
import { makeT } from '../i18n/t';
import { getLocale } from '../i18n/locale';

export function meta({ location, matches }: Route.MetaArgs) {
  const t = makeT(getLocale(location.pathname));
  return seoMeta({
    matches,
    path: '/contracts',
    title: t('contracts.metaTitle'),
    description: t('contracts.metaDescription'),
  });
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
  const locale = getLocale(request);
  // Page `Cache-Control` (publicCache(1800)) memoises full responses at the edge — no per-query cache.
  return withDbRetry(async () => {
    const [summary, facets] = await Promise.all([
      contractsSummary(env.DB, params),
      getContractFacets(env.DB, locale),
    ]);
    const result = await listContracts(env.DB, params, locale, summary);
    return { result, facets };
  });
}

export default function Contracts({ loaderData }: Route.ComponentProps) {
  const { result, facets } = loaderData;
  const t = useTranslation();
  const locale = useLocale();
  const VALUE_BUCKETS = [
    { value: 'lt100k', label: t('contracts.bucketLt100k') },
    { value: '100k-1m', label: t('contracts.bucket100k1m') },
    { value: '1m-10m', label: t('contracts.bucket1m10m') },
    { value: '10m-100m', label: t('contracts.bucket10m100m') },
    { value: 'gt100m', label: t('contracts.bucketGt100m') },
  ];
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
      locale,
    ),
    {
      key: 'procedure',
      label: t('contracts.filterProcedure'),
      type: 'checkbox',
      selected: getMulti(sp, 'procedure'),
      options: facets.procedures.map((p) => ({ value: p.value, label: p.label, count: p.count })),
    },
    {
      key: 'year',
      label: t('contracts.filterYear'),
      type: 'checkbox',
      selected: getMulti(sp, 'year'),
      options: facets.years.map((y) => ({ value: y.value, label: y.label, count: y.count })),
    },
    {
      key: 'value',
      label: t('contracts.filterValue'),
      type: 'radio',
      selected: sp.get('value') ? [sp.get('value')!] : [],
      options: VALUE_BUCKETS,
    },
    {
      key: 'eu',
      label: t('contracts.filterEu'),
      type: 'radio',
      selected: sp.get('eu') ? [sp.get('eu')!] : [],
      options: [
        { value: 'eu', label: t('contracts.euOnly') },
        { value: 'national', label: t('contracts.nationalOnly') },
      ],
    },
  ];

  const startRank = leaderboardRankOffset(nav.page, PAGE_SIZE.contracts);

  return (
    <>
      <Breadcrumbs
        items={[
          { label: t('contracts.breadcrumbHome'), to: '/' },
          { label: t('contracts.breadcrumbContracts') },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker={plural(
            result.total,
            t('contracts.kicker_one', { count: count(result.total, locale) }),
            t('contracts.kicker_many', { count: count(result.total, locale) }),
            locale,
          )}
          title={t('contracts.title')}
          lede={t('contracts.lede')}
        />

        <div className="split">
          <FilterRail groups={groups} sort={sort} clearHref="/contracts" csvHref={csvHref} />
          <section>
            <ListControls
              base={sp}
              activeSort={sort}
              sorts={[
                { value: 'date-desc', label: t('contracts.sortNew') },
                { value: 'date-asc', label: t('contracts.sortOld') },
                { value: 'value-desc', label: t('contracts.sortValueDesc') },
                { value: 'value-asc', label: t('contracts.sortValueAsc') },
              ]}
              count={
                <>
                  {t('contracts.foundPre')}
                  <strong>{count(result.total, locale)}</strong>{' '}
                  {plural(
                    result.total,
                    t('contracts.foundContracts_one'),
                    t('contracts.foundContracts_many'),
                    locale,
                  )}{' '}
                  · <strong>{money(result.valueEur, locale)}</strong>
                  {result.suspect > 0 && (
                    <>
                      {' '}
                      ·{' '}
                      <span className="suspect">
                        {t('contracts.suspectCount', { count: count(result.suspect, locale) })}
                      </span>
                    </>
                  )}
                </>
              }
            />

            {filtered && (
              <p className="active-filters">
                {t('contracts.filteredBy')}
                {fAuthority && (
                  <>
                    {t('contracts.filterAuthority')}
                    {filterAuthorityName ? (
                      <>
                        {' '}
                        <strong>{filterAuthorityName}</strong>
                      </>
                    ) : null}
                  </>
                )}
                {fAuthority && fBidder ? t('contracts.filterAnd') : ''}
                {fBidder && (
                  <>
                    {t('contracts.filterBidder')}
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
                  {t('contracts.clear')}
                </Link>
              </p>
            )}

            {result.items.length === 0 ? (
              <p className="muted">
                {t('contracts.noResults')}
                <Link to="/contracts">{t('contracts.clearFilters')}</Link>
              </p>
            ) : (
              <div className="table-wrap tbl-cards" aria-busy={busy || undefined}>
                <table>
                  <caption className="sr-only">{t('contracts.tableCaption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="col-w-32">
                        {t('contracts.thRank')}
                      </th>
                      <th scope="col">{t('contracts.thContract')}</th>
                      <th scope="col">{t('contracts.thParties')}</th>
                      <th scope="col" className="col-secondary">
                        {t('contracts.thProcedureDate')}
                      </th>
                      <th scope="col" className="num">
                        {t('contracts.thValue')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items.map((c, i) => (
                      <tr className="contract-row" key={c.id}>
                        <td className="rank cell-rank" data-label={t('contracts.thRank')}>
                          {startRank + i + 1}
                        </td>
                        <td className="subj cell-title" data-label={t('contracts.thContract')}>
                          <Link className="title" to={`/contracts/${c.id}`}>
                            {c.subject}
                          </Link>
                          {c.euFunded && <span className="eu">{t('contracts.euFunded')}</span>}
                          <span className="unp">
                            {t('contracts.unp', { unp: c.unp })}
                            {c.isConsortium ? t('contracts.consortiumSuffix') : ''}
                          </span>
                        </td>
                        <td className="parties" data-label={t('contracts.thParties')}>
                          <span className="from">
                            <Link to={`/authorities/${c.authoritySlug}`}>{c.authorityName}</Link>{' '}
                            <span className="who">{t('contracts.roleAuthority')}</span>
                          </span>
                          <span className="to">
                            <Link to={`/companies/${c.bidderSlug}`}>{c.bidderDisplayName}</Link>{' '}
                            <span className="who">{t('contracts.roleBidder')}</span>
                          </span>
                        </td>
                        <td
                          className="meta col-secondary"
                          data-label={t('contracts.thProcedureDate')}
                        >
                          <span className="pr">{c.procedureLabel}</span>
                          <br />
                          {date(c.signedAt, locale)}
                        </td>
                        <td className="money" data-label={t('contracts.thValue')}>
                          {c.valueEur != null ? (
                            moneyBare(c.valueEur, locale)
                          ) : (
                            <span className="suspect">{t('contracts.valueChecking')}</span>
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
              <h2>{t('contracts.calloutTitle')}</h2>
              <p className="m-0">{t('contracts.calloutBody')}</p>
            </Callout>
          </section>
        </div>
      </main>
    </>
  );
}
