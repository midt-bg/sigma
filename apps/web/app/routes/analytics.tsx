import { Link } from '../i18n/Link';
import { getCompetitionSummary, getFlows, getRegionalSpending, getSpendingTrend } from '@sigma/db';
import { count, money, pct } from '@sigma/shared';
import type { ReactNode } from 'react';
import type { Route } from './+types/analytics';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { Choropleth } from '../components/Choropleth';
import { TrendChart } from '../components/TrendChart';
import { SingleOfferPortion } from '../components/SingleOfferPortion';
import { Section, ShareBar } from '../components/ui';
import { useTranslation, useLocale } from '../i18n/context';
import { makeT } from '../i18n/t';
import { getLocale } from '../i18n/locale';
import { publicCache } from '../lib/cache';
import { ANALYTICS_LENSES } from '../lib/analytics-lenses';
import { seoMeta } from '../lib/meta';

export function meta({ matches, location }: Route.MetaArgs) {
  const t = makeT(getLocale(location.pathname));
  return seoMeta({
    matches,
    path: '/analytics',
    title: t('analytics.metaTitle'),
    description: t('analytics.metaDescription'),
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  const locale = getLocale(request);
  const [flows, regional, trend, competition] = await Promise.all([
    getFlows(db, { top: 3 }, locale),
    getRegionalSpending(db, { funding: 'all' }, locale),
    getSpendingTrend(
      db,
      { funding: 'all', granularity: 'year' },
      { includeSectors: false },
      locale,
    ),
    getCompetitionSummary(db, {}, locale),
  ]);

  return {
    flows: flows.pairs.slice(0, 3),
    regions: regional.regions.filter((region) => region.valueEur > 0).slice(0, 3),
    allRegions: regional.regions,
    regionTotal: regional.totalValueEur,
    trend: {
      points: trend.points,
      latest: trend.years.at(-1) ?? null,
      peak: trend.years.reduce(
        (best, year) => (best == null || year.valueEur > best.valueEur ? year : best),
        null as (typeof trend.years)[number] | null,
      ),
    },
    competition: {
      totals: competition.totals,
      topConcentration: competition.topConcentration,
    },
  };
}

function LensLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <p className="lens-link">
      <Link to={to}>{children}</Link>
    </p>
  );
}

export default function Analytics({ loaderData }: Route.ComponentProps) {
  const { flows, regions, allRegions, regionTotal, trend, competition } = loaderData;
  const t = useTranslation();
  const locale = useLocale();

  return (
    <>
      <Breadcrumbs
        items={[
          { label: t('analytics.breadcrumbHome'), to: '/' },
          { label: t('analytics.breadcrumbAnalytics') },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker={t('analytics.kicker')}
          title={t('analytics.title')}
          lede={t('analytics.lede')}
        />

        <Section id="lenses" title={t('analytics.lensesTitle')} hint={t('analytics.lensesHint')}>
          <div className="tiles analytics-lenses">
            {ANALYTICS_LENSES.map((lens) => (
              <article className="tile lens-card" key={lens.href}>
                <p className="kicker info">{t('analytics.lensKicker')}</p>
                <h3>
                  <Link to={lens.href}>{t(`analytics.lens.${lens.key}.title`)}</Link>
                </h3>
                <p className="desc">{t(`analytics.lens.${lens.key}.desc`)}</p>
                {lens.href === '/flows' && (
                  <div className="lens-preview">
                    <p className="lens-preview-title">{t('analytics.flowsPreviewTitle')}</p>
                    {flows.length ? (
                      <ul className="lens-list">
                        {flows.map((flow) => (
                          <li key={`${flow.authoritySlug}-${flow.bidderSlug}`}>
                            <span className="lens-name">
                              {flow.authorityName} → {flow.bidderDisplayName}
                            </span>
                            <span className="lens-value">{money(flow.wonEur, locale)}</span>
                            <span className="lens-meta">
                              {t('analytics.contracts', { count: count(flow.contracts, locale) })}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">{t('analytics.flowsEmpty')}</p>
                    )}
                  </div>
                )}
                {lens.href === '/map' && (
                  <div className="lens-preview">
                    <div className="lens-map">
                      <Choropleth regions={allRegions} />
                    </div>
                    <p className="lens-preview-title">{t('analytics.mapPreviewTitle')}</p>
                    {regions.length ? (
                      <ul className="lens-list">
                        {regions.map((region) => (
                          <li key={region.nuts3}>
                            <span className="lens-name">{region.name}</span>
                            <span className="lens-value">{money(region.valueEur, locale)}</span>
                            <span className="lens-share">
                              <ShareBar
                                ratio={regionTotal > 0 ? region.valueEur / regionTotal : 0}
                              />
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">{t('analytics.mapEmpty')}</p>
                    )}
                  </div>
                )}
                {lens.href === '/trends' && (
                  <div className="lens-preview">
                    <p className="lens-preview-title">{t('analytics.trendsPreviewTitle')}</p>
                    {trend.points.length >= 2 ? (
                      <>
                        <div className="lens-chart">
                          <TrendChart points={trend.points} granularity="year" />
                        </div>
                        <dl className="lens-metrics">
                          {trend.latest && (
                            <div>
                              <dt>
                                {trend.latest.partial
                                  ? t('analytics.trendsCurrentYear')
                                  : t('analytics.trendsLatestYear')}
                              </dt>
                              <dd>
                                {trend.latest.year} · {money(trend.latest.valueEur, locale)}
                                {trend.latest.partial && (
                                  <span className="muted"> · {t('analytics.trendsPartial')}</span>
                                )}
                              </dd>
                            </div>
                          )}
                          {trend.peak && (
                            <div>
                              <dt>{t('analytics.trendsPeak')}</dt>
                              <dd>
                                {trend.peak.year} · {money(trend.peak.valueEur, locale)}
                              </dd>
                            </div>
                          )}
                        </dl>
                      </>
                    ) : (
                      <p className="muted">{t('analytics.trendsEmpty')}</p>
                    )}
                  </div>
                )}
                {lens.href === '/competition' && (
                  <div className="lens-preview">
                    <p className="lens-preview-title">{t('analytics.competitionPreviewTitle')}</p>
                    <SingleOfferPortion
                      valueEur={competition.totals.singleOfferValueEur}
                      totalEur={competition.totals.valueEur}
                      singleOffer={competition.totals.singleOffer}
                      contracts={competition.totals.contracts}
                    />
                    {competition.topConcentration && (
                      <p className="small muted">
                        {t('analytics.competitionTopConcentrationPre')}
                        <Link to={`/authorities/${competition.topConcentration.slug}`}>
                          {competition.topConcentration.name}
                        </Link>{' '}
                        {t('analytics.competitionTopConcentrationIndex', {
                          index: pct(competition.topConcentration.hhi, undefined, locale),
                        })}
                      </p>
                    )}
                  </div>
                )}
                <LensLink to={lens.href}>
                  {t('analytics.viewLink', {
                    lens: t(`analytics.lens.${lens.key}.title`).toLowerCase(),
                  })}
                </LensLink>
              </article>
            ))}
          </div>
        </Section>
      </main>
    </>
  );
}
