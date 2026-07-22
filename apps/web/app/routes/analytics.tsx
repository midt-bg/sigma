import type { ReactNode } from 'react';
import { Link } from 'react-router';
import {
  getFlowsHeadline,
  getOpaqueShareByYear,
  getOverrunsHeadline,
  getRegionHeadline,
  getSpendingTrend,
} from '@sigma/db';
import { count, money, pct } from '@sigma/shared';
import type { Route } from './+types/analytics';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { MetricInfo } from '../components/MetricInfo';
import { publicCache } from '../lib/cache';
import {
  estimateYoyGrowth,
  formatPeakMonth,
  formatPpChange,
  formatYearlyGrowth,
  growthMultiple,
  opaqueHeadline,
  peakPoint,
} from '../lib/analytics-stats';
import { seoMeta } from '../lib/meta';

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({
    matches,
    path: '/analytics',
    title: 'Анализи — СИГМА',
    description:
      'Пет аналитични изгледа към едни и същи обществени поръчки: раздуване след анекси, потоци на парите, карта по области, тренд във времето и конкуренция на процедурите — всеки води обратно към конкретните договори.',
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

// Five lean, bounded rollup reads — one per landing card — in a single Promise.all (edge-cached
// 1800s). Query budget: getOverrunsHeadline (1) + getFlowsHeadline (1) + getRegionHeadline (1) +
// getSpendingTrend month series (3: series + coverage + as_of) + getOpaqueShareByYear (1) = 7
// statements per cold load. The derivations (avg YoY, peak month, opaque headline) are pure helpers.
export async function loader({ context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  const [overruns, flows, region, trend, opaque] = await Promise.all([
    getOverrunsHeadline(db),
    getFlowsHeadline(db),
    getRegionHeadline(db),
    getSpendingTrend(db, { funding: 'all', granularity: 'month' }, { includeSectors: false }),
    getOpaqueShareByYear(db),
  ]);

  const peak = peakPoint(trend.points);
  // Canonical YoY growth (3-year trailing median of complete-year ratios, clamped — ported from the
  // retired /trends forecast) over the SAME trend points the loader already fetched. The
  // multiplier (1.15) is reported as a ratio (0.15 → „+15%/год") via formatYearlyGrowth.
  const growth = estimateYoyGrowth(trend.points);
  return {
    overruns,
    flows,
    region,
    trend: { avgYoy: growth.value - 1, peakPeriod: peak?.period ?? null },
    opaque: opaqueHeadline(opaque),
  };
}

interface Stat {
  value: string;
  label: string;
  accent?: boolean;
  // Plain-language description shown in the ⓘ popover for this stat (the card uses a stretched link, so
  // the MetricInfo button is valid — it sits above the link, not inside an anchor).
  summary?: string;
  // Optional analytical readout / extra gloss line in the popover (e.g. what the „×" factor means).
  hint?: string;
}

interface CardProps {
  index: string;
  category: string;
  to: string;
  titlePre: string;
  titleEm: string;
  emClass?: string;
  desc: string;
  cta: string;
  stats: Stat[];
  thumb: ReactNode;
}

// One full-width hero card: editorial left pane (eyebrow → serif title → 2-line description → KPI
// footer + CTA) and a decorative right pane carrying a static thumbnail. The whole card is a single
// real anchor (keyboard-focusable, visible focus ring in CSS); the thumbnail makes no data claim and
// is hidden from assistive tech, while the two KPI figures are plain text.
function AnalyzeCard({
  index,
  category,
  to,
  titlePre,
  titleEm,
  emClass,
  desc,
  cta,
  stats,
  thumb,
}: CardProps) {
  return (
    <div className="az-card">
      <div className="az-card-main">
        <p className="az-card-eyebrow">
          <span className="az-card-index">ИЗГЛЕД · {index}</span>
          <span className="az-card-cat">{category}</span>
        </p>
        <h2 className="az-card-title">
          {/* stretched link: makes the whole card clickable while the stat ⓘ buttons stay above it */}
          <Link className="az-card-stretch" to={to}>
            {titlePre}
            <em className={emClass}>{titleEm}</em>
          </Link>
        </h2>
        <p className="az-card-desc">{desc}</p>
        <div className="az-card-foot">
          <dl className="az-card-stats">
            {stats.map((s) => (
              <div key={s.label}>
                <dd className={s.accent ? 'az-stat-num az-stat-num--accent' : 'az-stat-num'}>
                  {s.value}
                </dd>
                <dt className="az-stat-label">
                  {s.label}
                  {s.summary ? (
                    <MetricInfo title={s.label} summary={s.summary} readout={s.hint} />
                  ) : null}
                </dt>
              </div>
            ))}
          </dl>
          <span className="az-card-cta">{cta} →</span>
        </div>
      </div>
      <div className="az-card-thumb" aria-hidden="true">
        {thumb}
      </div>
    </div>
  );
}

// ── Decorative thumbnails (aria-hidden, static geometry; colours come from the CSS block) ──────────

function ThumbOverruns() {
  // before → now stacked bars, 4 rows: an ink base segment extended by an accent overrun segment.
  const rows = [
    { base: 90, grow: 60 },
    { base: 70, grow: 95 },
    { base: 120, grow: 40 },
    { base: 55, grow: 70 },
  ];
  return (
    <svg className="az-thumb" viewBox="0 0 320 168" focusable="false">
      {rows.map((r, i) => {
        const y = 22 + i * 34;
        return (
          <g key={i}>
            <rect className="az-fill-ink" x="26" y={y} width={r.base} height="16" rx="2" />
            <rect
              className="az-fill-accent"
              x={26 + r.base}
              y={y}
              width={r.grow}
              height="16"
              rx="2"
            />
          </g>
        );
      })}
    </svg>
  );
}

function ThumbFlows() {
  // Two ribbons weaving from a left authority bar to right company bars (slate + accent).
  return (
    <svg className="az-thumb" viewBox="0 0 320 168" focusable="false">
      <path
        className="az-fill-slate az-thumb-soft"
        d="M40,30 C140,30 180,52 280,52 L280,80 C180,80 140,86 40,86 Z"
      />
      <path
        className="az-fill-accent az-thumb-soft"
        d="M40,94 C140,98 180,118 280,118 L280,146 C180,146 140,108 40,100 Z"
      />
      <rect className="az-fill-ink" x="28" y="26" width="12" height="120" rx="2" />
      <rect className="az-fill-slate" x="280" y="48" width="12" height="36" rx="2" />
      <rect className="az-fill-accent" x="280" y="114" width="12" height="36" rx="2" />
    </svg>
  );
}

function ThumbMap() {
  // Stylised choropleth grid — warm tiles of varying weight, the capital tile picked out in accent.
  const tiles: (number | 'sofia')[] = [1, 2, 1, 3, 2, 'sofia', 1, 2, 1, 3, 2, 1];
  const cls = (v: number | 'sofia') =>
    v === 'sofia'
      ? 'az-fill-accent'
      : v === 3
        ? 'az-fill-ink'
        : v === 2
          ? 'az-fill-slate az-thumb-soft'
          : 'az-fill-rule';
  return (
    <svg className="az-thumb" viewBox="0 0 320 168" focusable="false">
      {tiles.map((v, i) => {
        const col = i % 4;
        const row = Math.floor(i / 4);
        return (
          <rect
            key={i}
            className={cls(v)}
            x={40 + col * 60}
            y={26 + row * 42}
            width="50"
            height="32"
            rx="3"
          />
        );
      })}
    </svg>
  );
}

function ThumbTrends() {
  // Area under an actual line, a dashed forecast tail, and an accent peak dot.
  return (
    <svg className="az-thumb" viewBox="0 0 320 168" focusable="false">
      <path
        className="az-fill-tan az-thumb-soft"
        d="M24,132 L24,120 70,104 116,118 162,78 208,52 208,132 Z"
      />
      <polyline
        className="az-stroke-ink"
        points="24,120 70,104 116,118 162,78 208,52"
        fill="none"
      />
      <polyline
        className="az-stroke-accent az-thumb-dash"
        points="208,52 254,60 300,40"
        fill="none"
      />
      <circle className="az-fill-accent" cx="208" cy="52" r="5" />
    </svg>
  );
}

function ThumbCompetition() {
  // A single line trending up under a faint area — the rising opaque-spend share.
  return (
    <svg className="az-thumb" viewBox="0 0 320 168" focusable="false">
      <path
        className="az-fill-accent az-thumb-faint"
        d="M28,138 L28,118 96,110 164,86 232,74 296,44 296,138 Z"
      />
      <polyline
        className="az-stroke-accent"
        points="28,118 96,110 164,86 232,74 296,44"
        fill="none"
      />
      <circle className="az-fill-accent" cx="296" cy="44" r="5" />
    </svg>
  );
}

export default function Analytics({ loaderData }: Route.ComponentProps) {
  const { overruns, flows, region, trend, opaque } = loaderData;

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Анализи' }]} />
      <main id="main">
        <div className="analyze-landing">
          <header className="az-masthead">
            <p className="az-kicker">— Анализи</p>
            <h1 className="az-title">
              Едни и същи пари, <em>видени иначе</em>
            </h1>
            <p className="az-lede">
              Всеки изглед отговаря на различен въпрос за обществените поръчки, но всички водят
              обратно към конкретните договори. Избери ъгъл.
            </p>
          </header>

          <div className="az-cards">
            <AnalyzeCard
              index="01"
              category="СТОЙНОСТ СЛЕД АНЕКСИ"
              to="/overruns"
              titlePre="Раздуване на "
              titleEm="договорите"
              desc="Кои договори, институции и сектори раздуват най-много стойността си след сключване — и тенденцията във времето."
              cta="Виж раздуването"
              stats={[
                {
                  value: money(overruns.totalOverrunEur),
                  label: 'ОБЩО РАЗДУВАНЕ',
                  accent: true,
                  summary:
                    'Сумата, с която стойността на договорите е нараснала над стойността при сключване, чрез анекси.',
                },
                {
                  value: growthMultiple(overruns.medianPct),
                  label: 'ТИПИЧЕН РАСТЕЖ',
                  summary:
                    'Типичното нарастване — половината договори растат повече, половината по-малко.',
                  hint: '„×" = колко пъти спрямо стойността при сключване.',
                },
              ]}
              thumb={<ThumbOverruns />}
            />

            <AnalyzeCard
              index="02"
              category="ВЪЗЛОЖИТЕЛ → ИЗПЪЛНИТЕЛ"
              to="/flows"
              titlePre="Потоци на "
              titleEm="парите"
              emClass="az-em-slate"
              desc="Накъде текат парите — от възложители към сектори и изпълнители, и кои двойки концентрират най-голям обем."
              cta="Виж потоците"
              stats={[
                {
                  value: count(flows.authorities),
                  label: 'ВЪЗЛОЖИТЕЛЯ',
                  summary: 'Брой институции-възложители с поне един договор в данните.',
                },
                {
                  value: count(flows.pairs),
                  label: 'ВРЪЗКИ',
                  summary: 'Брой уникални двойки възложител → изпълнител — потоците на парите.',
                },
              ]}
              thumb={<ThumbFlows />}
            />

            <AnalyzeCard
              index="03"
              category="ПО ОБЛАСТИ"
              to="/map"
              titlePre="Карта на "
              titleEm="разходите"
              desc="Къде по области се концентрират разходите за обществени поръчки и как изглежда страната на глава от населението."
              cta="Виж картата"
              stats={[
                {
                  value: count(region.regionCount),
                  label: 'ОБЛАСТИ',
                  summary: 'Брой области (NUTS3 региони), по които се разпределят разходите.',
                },
                {
                  value: pct(region.sofiaShare),
                  label: 'В СОФИЯ',
                  summary:
                    'Дял от разходите, концентриран в столицата спрямо всички области с посочен регион.',
                },
              ]}
              thumb={<ThumbMap />}
            />

            <AnalyzeCard
              index="04"
              category="ВЪВ ВРЕМЕТО"
              to="/trends"
              titlePre="Тренд във "
              titleEm="времето"
              desc="Как се движат разходите по месеци и години — сезонните пикове в края на годината, само по реални данни."
              cta="Виж тренда"
              stats={[
                {
                  value: formatYearlyGrowth(trend.avgYoy),
                  label: 'СРЕДЕН РЪСТ',
                  accent: true,
                  summary: 'Типичният годишен ръст на разходите за последните 3 пълни години.',
                  hint: 'Изчислено от същите месечни данни като на страницата „Тренд" — там стойността не се показва (без прогноза за бъдещето).',
                },
                {
                  value: formatPeakMonth(trend.peakPeriod),
                  label: 'ПИК',
                  summary: 'Месецът с най-висока сумарна стойност на сключени договори.',
                },
              ]}
              thumb={<ThumbTrends />}
            />

            <AnalyzeCard
              index="05"
              category="ПРОЗРАЧНОСТ НА ПРОЦЕДУРИТЕ"
              to="/competition"
              titlePre="Конкуренция на "
              titleEm="харченето"
              desc="Каква част от парите минават през непрозрачни процедури — и расте ли този дял година след година."
              cta="Виж конкуренцията"
              stats={[
                {
                  value: opaque ? pct(opaque.latestShare) : '—',
                  label: opaque ? `НЕПРОЗРАЧНИ ${opaque.latestYear}` : 'НЕПРОЗРАЧНИ',
                  accent: true,
                  summary:
                    'Дял на парите през процедури само с една оферта — за последната пълна година.',
                  hint: 'Висок дял = по-слаба конкуренция.',
                },
                {
                  value: opaque ? formatPpChange(opaque.ppChange) : '—',
                  label: opaque ? `ОТ ${opaque.firstYear}` : 'ПРОМЯНА',
                  summary:
                    'Промяната в този дял спрямо първата година с данни — в процентни пунктове.',
                },
              ]}
              thumb={<ThumbCompetition />}
            />
          </div>

          <p className="small muted source-line">Данни: Регистър на обществените поръчки (АОП)</p>
        </div>
      </main>
    </>
  );
}
