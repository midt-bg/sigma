import { Link } from 'react-router';
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
import { publicCache } from '../lib/cache';
import { ANALYTICS_LENSES } from '../lib/analytics-lenses';
import { seoMeta } from '../lib/meta';

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({
    matches,
    path: '/analytics',
    title: 'Анализи — СИГМА',
    description:
      'Четири аналитични изгледа към обществените поръчки: потоци, карта, тренд и конкуренция.',
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  const [flows, regional, trend, competition] = await Promise.all([
    getFlows(db, { top: 3 }),
    getRegionalSpending(db, { funding: 'all' }),
    getSpendingTrend(db, { funding: 'all', granularity: 'year' }, { includeSectors: false }),
    getCompetitionSummary(db),
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

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Анализи' }]} />
      <main id="main">
        <PageHeader
          kicker="Анализи"
          title="Анализи"
          lede="Четири начина да проследиш едни и същи обществени поръчки: като движение на пари, карта, времева линия и сигнал за слаба конкуренция."
        />

        <Section
          id="lenses"
          title="Изгледи"
          hint="Всеки изглед отговаря на различен въпрос, но всички водят обратно към конкретните договори."
        >
          <div className="tiles analytics-lenses">
            {ANALYTICS_LENSES.map((lens) => (
              <article className="tile lens-card" key={lens.href}>
                <p className="kicker info">Изглед</p>
                <h3>
                  <Link to={lens.href}>{lens.title}</Link>
                </h3>
                <p className="desc">{lens.desc}</p>
                {lens.href === '/flows' && (
                  <div className="lens-preview">
                    <p className="lens-preview-title">Най-големи национални потоци</p>
                    {flows.length ? (
                      <ul className="lens-list">
                        {flows.map((flow) => (
                          <li key={`${flow.authoritySlug}-${flow.bidderSlug}`}>
                            <span className="lens-name">
                              {flow.authorityName} → {flow.bidderDisplayName}
                            </span>
                            <span className="lens-value">{money(flow.wonEur)}</span>
                            <span className="lens-meta">{count(flow.contracts)} договора</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">Няма достатъчно данни за потоци.</p>
                    )}
                  </div>
                )}
                {lens.href === '/map' && (
                  <div className="lens-preview">
                    <div className="lens-map">
                      <Choropleth regions={allRegions} />
                    </div>
                    <p className="lens-preview-title">Водещи области по стойност</p>
                    {regions.length ? (
                      <ul className="lens-list">
                        {regions.map((region) => (
                          <li key={region.nuts3}>
                            <span className="lens-name">{region.name}</span>
                            <span className="lens-value">{money(region.valueEur)}</span>
                            <span className="lens-share">
                              <ShareBar
                                ratio={regionTotal > 0 ? region.valueEur / regionTotal : 0}
                              />
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">Няма достатъчно данни по области.</p>
                    )}
                  </div>
                )}
                {lens.href === '/trends' && (
                  <div className="lens-preview">
                    <p className="lens-preview-title">Годишен национален тренд</p>
                    {trend.points.length >= 2 ? (
                      <>
                        <div className="lens-chart">
                          <TrendChart points={trend.points} granularity="year" />
                        </div>
                        <dl className="lens-metrics">
                          {trend.latest && (
                            <div>
                              <dt>{trend.latest.partial ? 'Текуща година' : 'Последна година'}</dt>
                              <dd>
                                {trend.latest.year} · {money(trend.latest.valueEur)}
                                {trend.latest.partial && <span className="muted"> · частично</span>}
                              </dd>
                            </div>
                          )}
                          {trend.peak && (
                            <div>
                              <dt>Пик</dt>
                              <dd>
                                {trend.peak.year} · {money(trend.peak.valueEur)}
                              </dd>
                            </div>
                          )}
                        </dl>
                      </>
                    ) : (
                      <p className="muted">Няма достатъчно данни за тренд.</p>
                    )}
                  </div>
                )}
                {lens.href === '/competition' && (
                  <div className="lens-preview">
                    <p className="lens-preview-title">Национален дял с една оферта</p>
                    <SingleOfferPortion
                      valueEur={competition.totals.singleOfferValueEur}
                      totalEur={competition.totals.valueEur}
                      singleOffer={competition.totals.singleOffer}
                      contracts={competition.totals.contracts}
                    />
                    {competition.topConcentration && (
                      <p className="small muted">
                        Най-концентриран възложител:{' '}
                        <Link to={`/authorities/${competition.topConcentration.slug}`}>
                          {competition.topConcentration.name}
                        </Link>{' '}
                        (индекс {pct(competition.topConcentration.hhi)})
                      </p>
                    )}
                  </div>
                )}
                <LensLink to={lens.href}>Виж {lens.title.toLowerCase()} →</LensLink>
              </article>
            ))}
          </div>
        </Section>
      </main>
    </>
  );
}
