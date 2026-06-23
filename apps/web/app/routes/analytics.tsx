import { Link } from 'react-router';
import { getCompetition, getFlows, getRegionalSpending, getSpendingTrend } from '@sigma/db';
import { count, money, pct } from '@sigma/shared';
import type { Route } from './+types/analytics';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { Choropleth } from '../components/Choropleth';
import { TrendChart } from '../components/TrendChart';
import { Section, ShareBar } from '../components/ui';
import { publicCache } from '../lib/cache';
import { seoMeta } from '../lib/meta';

const LENSES = [
  {
    href: '/flows',
    title: 'Потоци',
    desc: 'Накъде текат парите: от възложители към сектори и изпълнители.',
  },
  {
    href: '/map',
    title: 'Карта',
    desc: 'Къде по области се концентрират разходите за обществени поръчки.',
  },
  {
    href: '/trends',
    title: 'Тренд',
    desc: 'Как се движат разходите във времето по месеци и години.',
  },
  {
    href: '/competition',
    title: 'Конкуренция',
    desc: 'Къде има висок дял „една оферта“ и концентрация на доставчици.',
  },
];

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
    getFlows(db, { top: 20 }),
    getRegionalSpending(db, { funding: 'all' }),
    getSpendingTrend(db, { funding: 'all', granularity: 'year' }),
    getCompetition(db, { top: 20 }),
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
      topConcentration: competition.byConcentration[0] ?? null,
    },
  };
}

function LensLink({ to, children }: { to: string; children: string }) {
  return (
    <p className="lens-link">
      <Link to={to}>{children}</Link>
    </p>
  );
}

function SingleOfferPreview({
  valueEur,
  totalEur,
  singleOffer,
  contracts,
}: {
  valueEur: number;
  totalEur: number;
  singleOffer: number;
  contracts: number;
}) {
  const ratio = Math.min(1, Math.max(0, totalEur > 0 ? valueEur / totalEur : 0));
  return (
    <div className="so-portion">
      <p className="so-portion-head">
        <span className="so-portion-pct">{pct(ratio)}</span> от стойността е по договори с{' '}
        <em>една оферта</em>.
      </p>
      <div className="hbar" aria-hidden="true">
        <span style={{ width: `${(ratio * 100).toFixed(1)}%`, background: 'var(--accent)' }} />
        <span
          style={{ width: `${((1 - ratio) * 100).toFixed(1)}%`, background: 'var(--ink-soft)' }}
        />
      </div>
      <p className="small muted so-portion-cap">
        {count(singleOffer)} от {count(contracts)} договора · {money(valueEur)} от {money(totalEur)}
      </p>
    </div>
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
            <article className="tile lens-card">
              <p className="kicker info">Изглед</p>
              <h3>
                <Link to="/flows">Потоци</Link>
              </h3>
              <p className="desc">{LENSES[0]!.desc}</p>
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
              <LensLink to="/flows">Виж Потоци →</LensLink>
            </article>

            <article className="tile lens-card">
              <p className="kicker info">Изглед</p>
              <h3>
                <Link to="/map">Карта</Link>
              </h3>
              <p className="desc">{LENSES[1]!.desc}</p>
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
                          <ShareBar ratio={regionTotal > 0 ? region.valueEur / regionTotal : 0} />
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">Няма достатъчно данни по области.</p>
                )}
              </div>
              <LensLink to="/map">Виж картата →</LensLink>
            </article>

            <article className="tile lens-card">
              <p className="kicker info">Изглед</p>
              <h3>
                <Link to="/trends">Тренд</Link>
              </h3>
              <p className="desc">{LENSES[2]!.desc}</p>
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
              <LensLink to="/trends">Виж тренда →</LensLink>
            </article>

            <article className="tile lens-card">
              <p className="kicker info">Изглед</p>
              <h3>
                <Link to="/competition">Конкуренция</Link>
              </h3>
              <p className="desc">{LENSES[3]!.desc}</p>
              <div className="lens-preview">
                <p className="lens-preview-title">Национален дял с една оферта</p>
                <SingleOfferPreview
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
              <LensLink to="/competition">Виж конкуренцията →</LensLink>
            </article>
          </div>
        </Section>
      </main>
    </>
  );
}
