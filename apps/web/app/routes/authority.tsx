import { Link } from '../i18n/Link';
import { count, decimal, money, moneyBare, pct, periodRange, plural } from '@sigma/shared';
import {
  authorityIdFromSlug,
  getAuthority,
  getAuthoritySingleOffer,
  getEntityNetwork,
  getSpendingTrend,
} from '@sigma/db';
import type { Route } from './+types/authority';
import { makeT } from '../i18n/t';
import { getLocale } from '../i18n/locale';
import { useTranslation, useLocale } from '../i18n/context';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FactsList } from '../components/FactsList';
import { StackedBar } from '../components/StackedBar';
import { DataTable } from '../components/DataTable';
import { TrendChart } from '../components/TrendChart';
import { NetworkGraph } from '../components/NetworkGraph';
import { ContractMiniTable } from '../components/ContractMiniTable';
import { SingleOfferPortion } from '../components/SingleOfferPortion';
import { ShareBar, Chip, Section } from '../components/ui';
import { publicCache } from '../lib/cache';
import { coverageRange, getCoverageMeta } from '../lib/coverage';
import { networkColumns, networkRows, trendYearColumns } from '../lib/entity-tables';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';

export function meta({ data, params, location, matches }: Route.MetaArgs) {
  const t = makeT(getLocale(location.pathname));
  const name = data?.authority.name ?? t('authority.fallbackName');
  const range = coverageRange(data?.coverage.coverageEndYear);
  return seoMeta({
    matches,
    path: `/authorities/${params.eik}`,
    title: t('authority.metaTitle', { name }),
    description: t('authority.metaDescription', { name, range }),
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  if (!params.eik?.trim()) throw new Response('Not Found', { status: 404 });
  const locale = getLocale(request);
  const db = context.cloudflare.env.DB;
  const authorityId = authorityIdFromSlug(params.eik);
  return withDbRetry(async () => {
    const [authority, coverage, trend, network, competition] = await Promise.all([
      getAuthority(db, authorityId, locale),
      getCoverageMeta(db),
      getSpendingTrend(
        db,
        { authorityId, granularity: 'month' },
        { includeSectors: false },
        locale,
      ),
      getEntityNetwork(
        db,
        { kind: 'authority', id: authorityId },
        { includeCenterOptions: false },
        locale,
      ),
      getAuthoritySingleOffer(db, authorityId),
    ]);
    if (!authority) throw new Response('Not Found', { status: 404 });
    return { authority, coverage, trend, network, competition };
  });
}

export default function Authority({ loaderData }: Route.ComponentProps) {
  const t = useTranslation();
  const locale = useLocale();
  const a = loaderData.authority;
  const { trend, network, competition } = loaderData;
  const ct = competition;
  const range = coverageRange(loaderData.coverage.coverageEndYear);
  const topSectors = a.sectors
    .slice(0, 3)
    .map((s) => `${s.short.toLowerCase()} (${pct(s.sharePct, 1, locale)})`)
    .join(', ');
  return (
    <>
      <Breadcrumbs
        items={[
          { label: t('authority.breadcrumbHome'), to: '/' },
          { label: t('authority.breadcrumbAuthorities'), to: '/authorities' },
          { label: a.name },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker={
            <>
              {t('authority.kind')}
              {a.typeLabel && (
                <>
                  {' '}
                  · <Chip>{a.typeLabel}</Chip>
                </>
              )}
            </>
          }
          title={a.name}
          lede={t('authority.lede', { range })}
        />

        <FactsList
          label={t('authority.factsLabel')}
          rows={[
            { term: t('authority.factTotalValue'), value: money(a.spentEur, locale) },
            { term: t('authority.factContracts'), value: count(a.contracts, locale) },
            {
              term: t('authority.factPeriod'),
              value: periodRange(a.periodFirst, a.periodLast, locale),
            },
            { term: t('authority.factDistinctSuppliers'), value: count(a.suppliers, locale) },
            {
              term: t('authority.factEuShare'),
              value: pct(a.euSharePct, 1, locale),
              sub: t('authority.factEuShareSub'),
            },
            a.avgBids != null && {
              term: t('authority.factAvgBids'),
              value: decimal(a.avgBids, locale),
            },
            a.settlement
              ? { term: t('authority.factSeat'), value: a.settlement, sub: a.region ?? undefined }
              : {
                  term: t('authority.factSeat'),
                  value: <span className="muted">—</span>,
                  sub: t('authority.noData'),
                },
            topSectors ? { term: t('authority.factTopSectors'), value: topSectors } : null,
            a.suspect > 0 && {
              term: t('authority.factUnverifiedValue'),
              value: `${count(a.suspect, locale)} ${plural(a.suspect, t('authority.contracts_one'), t('authority.contracts_many'), locale)}`,
              sub: t('authority.unverifiedValueSub'),
            },
          ]}
        />

        <div className="two-col">
          <Section
            id="trend"
            title={t('authority.trendTitle')}
            hint={t('authority.trendHint', { name: a.name })}
          >
            {trend.points.length >= 2 ? (
              <>
                <TrendChart points={trend.points} granularity={trend.granularity} />
                <div className="mt-8">
                  <DataTable
                    columns={trendYearColumns(t, locale)}
                    rows={trend.years}
                    getKey={(r) => r.year}
                    caption={t('authority.trendCaption')}
                  />
                </div>
              </>
            ) : (
              <p className="muted">{t('authority.trendEmpty')}</p>
            )}
          </Section>

          <Section
            id="single-offer"
            title={t('authority.singleOfferTitle')}
            hint={t('authority.singleOfferHint')}
          >
            {ct.contracts > 0 ? (
              <div>
                <SingleOfferPortion
                  valueEur={ct.singleOfferValueEur}
                  totalEur={ct.valueEur}
                  singleOffer={ct.singleOffer}
                  contracts={ct.contracts}
                  scopeLabel={t('authority.singleOfferScope')}
                  captionSuffix={t('authority.singleOfferCaptionSuffix')}
                />
                <p className="small muted mt-8">
                  <Link to={`/competition?top=50`}>{t('authority.singleOfferCompareLink')}</Link>
                </p>
              </div>
            ) : (
              <p className="muted">{t('authority.singleOfferEmpty')}</p>
            )}
          </Section>
        </div>

        <Section
          id="network"
          title={t('authority.networkTitle')}
          hint={
            <span>
              {t('authority.networkHint')}{' '}
              <Link to={`/network?center=a:${a.eik}`}>{t('authority.networkFullLink')}</Link>
            </span>
          }
        >
          {network.center && network.nodes.length >= 2 ? (
            <>
              <NetworkGraph data={network} />
              <div className="sr-only">
                <DataTable
                  columns={networkColumns(t, locale)}
                  rows={networkRows(network)}
                  getKey={(r) => `${r.from}-${r.to}`}
                  caption={t('authority.networkCaption')}
                />
              </div>
            </>
          ) : (
            <p className="muted">{t('authority.networkEmpty')}</p>
          )}
        </Section>

        <Section
          id="top-contractors"
          title={t('authority.topContractorsTitle')}
          hint={t('authority.topContractorsHint', { name: a.name })}
        >
          <div className="table-wrap tbl-cards">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('authority.colRank')}</th>
                  <th scope="col">{t('authority.colCompany')}</th>
                  <th scope="col" className="num">
                    {t('authority.colWon')}
                  </th>
                  <th scope="col" className="num">
                    {t('authority.colContracts')}
                  </th>
                  <th scope="col">{t('authority.colShareOfTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {a.topContractors.map((co, i) => (
                  <tr key={co.slug}>
                    <td className="rank cell-rank" data-label={t('authority.colRank')}>
                      {i + 1}
                    </td>
                    <td className="cell-title" data-label={t('authority.colCompany')}>
                      <Link to={`/companies/${co.slug}`}>{co.displayName}</Link>
                      {co.kind === 'consortium' && (
                        <>
                          {' '}
                          <Chip>{t('authority.chipConsortium')}</Chip>
                        </>
                      )}
                    </td>
                    <td className="money" data-label={t('authority.colWon')}>
                      {money(co.wonEur, locale)}
                    </td>
                    <td className="money" data-label={t('authority.colContracts')}>
                      {count(co.contracts, locale)}
                    </td>
                    <td data-label={t('authority.labelShare')}>
                      <ShareBar ratio={co.sharePct} warn={co.sharePct >= 0.8} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {a.moreContractors > 0 && (
            <p className="small muted mt-s3">
              <Link to={`/contracts?authority=${a.eik}`}>
                {t('authority.moreContractors', { count: count(a.moreContractors, locale) })}
              </Link>
            </p>
          )}
        </Section>

        <div className="two-col">
          <Section id="what" title={t('authority.whatTitle')} hint={t('authority.whatHint')}>
            <table>
              <caption className="sr-only">{t('authority.whatCaption', { name: a.name })}</caption>
              <thead className="sr-only">
                <tr>
                  <th scope="col">{t('authority.whatColSector')}</th>
                  <th scope="col">{t('authority.whatColValueShare')}</th>
                </tr>
              </thead>
              <tbody>
                {a.sectors.map((s) => (
                  <tr key={s.code}>
                    <td>
                      <Link to={`/contracts?authority=${a.eik}&sector=${s.code}`}>
                        {s.label} (CPV {s.code})
                      </Link>
                    </td>
                    <td className="money">
                      {money(s.valueEur, locale)}
                      <span className="sub">{pct(s.sharePct, 1, locale)}</span>
                    </td>
                  </tr>
                ))}
                {a.sectorsOther && (
                  <tr>
                    <td className="muted">{a.sectorsOther.label}</td>
                    <td className="money">
                      {money(a.sectorsOther.valueEur, locale)}
                      <span className="sub">{pct(a.sectorsOther.sharePct, 1, locale)}</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Section>

          <Section id="how" title={t('authority.howTitle')} hint={t('authority.howHint')}>
            <StackedBar slices={a.procedureMix.filter((s) => s.sharePct >= 0.0005)} />
          </Section>
        </div>

        <Section
          id="all"
          title={t('authority.allTitle')}
          hint={
            <span>
              {t('authority.allHint', {
                count: count(a.contracts, locale),
                word: plural(
                  a.contracts,
                  t('authority.contracts_one'),
                  t('authority.contracts_many'),
                  locale,
                ),
                range,
              })}
            </span>
          }
        >
          <div className="tabset" role="radiogroup" aria-label={t('authority.contractsSortLabel')}>
            <input
              type="radio"
              name="authority-contracts"
              id="authority-recent"
              className="tab-input"
              defaultChecked
            />
            <input
              type="radio"
              name="authority-contracts"
              id="authority-top"
              className="tab-input"
            />
            <div className="tab-labels">
              <label id="tab-authority-recent" htmlFor="authority-recent">
                {t('authority.tabNewest')}
              </label>
              <label id="tab-authority-top" htmlFor="authority-top">
                {t('authority.tabLargest')}
              </label>
            </div>
            <div
              className="tab-panel"
              data-tab="recent"
              role="group"
              aria-labelledby="tab-authority-recent"
            >
              <ContractMiniTable items={a.recentContracts} counterparty="bidder" />
            </div>
            <div
              className="tab-panel"
              data-tab="top"
              role="group"
              aria-labelledby="tab-authority-top"
            >
              <ContractMiniTable items={a.topContracts} counterparty="bidder" />
            </div>
          </div>
          <p className="small muted mt-8">
            <Link to={`/contracts?authority=${a.eik}`}>{t('authority.viewAllCsv')}</Link>
          </p>
        </Section>
      </main>
    </>
  );
}
