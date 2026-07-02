import { Link } from 'react-router';
import type {
  QualityContractRow,
  QualityCoverageTier,
  QualityGrain,
  QualityPillars,
  QualityRankRow,
  QualityScorecard,
} from '@sigma/api-contract';
import { count, date, money, pct, plural } from '@sigma/shared';
import { getQuality, QUALITY_WEIGHTS } from '@sigma/db';
import type { Route } from './+types/quality';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { DataTable, type Column } from '../components/DataTable';
import { TotalsStrip, type Total } from '../components/TotalsStrip';
import { Callout, Chip, Section } from '../components/ui';
import { publicCache } from '../lib/cache';
import { seoMeta } from '../lib/meta';

// „Индекс на качеството" — the Contract Quality / Health Index page. Reads the ETL-built
// contract_features / *_quality_totals tables; every displayed score is [0,1] rendered as 0–100.
// Neutrality stance (spec §1.3): a low score is a weak-process SIGNAL, never proof of wrongdoing;
// contracts without a score are „недостатъчно данни", never zero.

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({
    matches,
    path: '/quality',
    title: 'Индекс на качеството — СИГМА',
    description:
      'Съставен индекс 0–100 за здравето на процеса по всеки договор: конкуренция, откритост, стойност, връзки и прозрачност. Сигнал за преглед, не присъда.',
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

const GRAIN_OPTIONS: { key: QualityGrain; label: string }[] = [
  { key: 'authority', label: 'Институция' },
  { key: 'supplier', label: 'Доставчик' },
  { key: 'sector', label: 'CPV сектор' },
  { key: 'region', label: 'Регион' },
  { key: 'year', label: 'Година' },
  { key: 'funding', label: 'Финансиране' },
];

const GRAIN_TITLES: Record<QualityGrain, string> = {
  authority: 'Институции',
  supplier: 'Доставчици',
  sector: 'CPV сектори',
  region: 'Региони',
  year: 'Години',
  funding: 'Източник на финансиране',
};

const PILLAR_META: {
  key: keyof QualityPillars;
  letter: string;
  name: string;
  desc: string;
  leaves: string[];
}[] = [
  {
    key: 'a',
    letter: 'A',
    name: 'Контестабилност',
    desc: 'брой оферти, участие на МСП',
    leaves: ['брой оферти (спрямо група)', 'единствена оферта', 'дял на МСП', 'електронен търг'],
  },
  {
    key: 'b',
    letter: 'B',
    name: 'Откритост на процедурата',
    desc: 'вид процедура, ускоряване',
    leaves: ['вид процедура', 'пряко/договаряне', 'ускорена процедура', 'срок за оферти'],
  },
  {
    key: 'c',
    letter: 'C',
    name: 'Интегритет на стойността',
    desc: 'превишения, точност, анекси',
    leaves: ['брой анекси', 'превишение спрямо подписаното', 'отклонение от прогнозата'],
  },
  {
    key: 'd',
    letter: 'D',
    name: 'Здраве на връзките',
    desc: 'концентрация, повторни печалби',
    leaves: ['HHI на купувача', 'повторни печалби', 'възраст на връзката', 'дял в сектора'],
  },
  {
    key: 'e',
    letter: 'E',
    name: 'Прозрачност / данни',
    desc: 'разкрития и чисти дати',
    leaves: ['ред на дати', 'разкрито подизпълнение', 'срок / заключване', 'корекции по обявата'],
  },
];

const COVERAGE_LABELS: Record<QualityCoverageTier, string> = {
  high: 'Високо',
  medium: 'Средно',
  low: 'Ниско',
  none: 'Няма оценка',
};

// §3.4 value_flag gate — static reference rows (the ETL applies these before any pillar is scored).
const GATE_ROWS: { flag: string; tone: 'good' | 'mid' | 'weak'; rule: string }[] = [
  { flag: 'ok', tone: 'good', rule: 'чист договор — оценяват се всички измерения.' },
  { flag: 'review', tone: 'mid', rule: 'сива зона на надценяване — стълб C × 0,90; увереност −1 ниво.' },
  { flag: 'value_low', tone: 'mid', rule: 'нулева/нищожна стойност — точността на прогнозата (C3) става NULL.' },
  { flag: 'annex_suspect', tone: 'weak', rule: 'анекс е раздул стойността — превишението (C2) става NULL; C от анексите.' },
  { flag: 'value_suspect', tone: 'weak', rule: 'извън прага за достоверност — цял C = NULL и договорът е НЕОЦЕНЕН, извън средните.' },
];

const COV_TIERS: { tier: QualityCoverageTier; range: string; label: string }[] = [
  { tier: 'high', range: '≥ 0,80', label: 'Високо · публикува се' },
  { tier: 'medium', range: '0,60 – 0,79', label: 'Средно · публикува се' },
  { tier: 'low', range: '0,40 – 0,59', label: 'Ниско · с уговорка' },
  { tier: 'none', range: '< 0,40', label: 'Без оценка · „недостатъчно данни"' },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  const sp = new URL(request.url).searchParams;
  let data = null;
  try {
    data = await getQuality(db, {
      grain: (sp.get('grain') as QualityGrain | null) ?? undefined,
      sort: sp.get('sort') === 'contracts' ? 'contracts' : 'score',
      contractSort: sp.get('csort') === 'value' ? 'value' : 'score',
      sel: sp.get('sel'),
      contractId: sp.get('contract'),
    });
  } catch (err) {
    // The health tables are built by the daily ETL (ship-domain rebuilds contract_features
    // DROP+CREATE); before the first derive — or mid-rebuild — they may not exist yet.
    if (!/no such table/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  return { data };
}

/** 0–100 display of a [0,1] score; „—" when unknown (never a fabricated 0). */
function score100(s: number | null | undefined): string {
  return s == null ? '—' : String(Math.round(s * 100));
}

function band(s: number | null | undefined): 'good' | 'mid' | 'weak' | 'unknown' {
  if (s == null) return 'unknown';
  if (s >= 0.7) return 'good';
  if (s >= 0.5) return 'mid';
  return 'weak';
}

function IndexBar({ score }: { score: number | null }) {
  if (score == null) return <span className="muted">—</span>;
  const width = `${Math.min(100, Math.max(0, score * 100)).toFixed(1)}%`;
  return (
    <span className={`q-index q-${band(score)}`}>
      <span className="q-index-num">{score100(score)}</span>
      <span className="q-index-bar" aria-hidden="true">
        <i style={{ width }} />
      </span>
    </span>
  );
}

// A–E mini bars. A NULL pillar renders as an empty track with an accessible „няма данни" title —
// unknown stays visually distinct from a true low score.
function PillarPills({ pillars }: { pillars: QualityPillars }) {
  return (
    <span className="q-pills" role="img" aria-label={pillarSummary(pillars)}>
      {PILLAR_META.map((p) => {
        const v = pillars[p.key];
        const h = v == null ? 2 : Math.max(2, v * 26);
        return (
          <span key={p.key} className="q-pill" title={`${p.name}: ${v == null ? 'няма данни' : score100(v)}`}>
            <i className={`q-${band(v)}`} style={{ height: `${h.toFixed(1)}px` }} />
            <b>{p.letter}</b>
          </span>
        );
      })}
    </span>
  );
}

function pillarSummary(pillars: QualityPillars): string {
  return PILLAR_META.map((p) => `${p.letter} ${score100(pillars[p.key])}`).join(', ');
}

function CovChip({ tier }: { tier: QualityCoverageTier }) {
  return <span className={`q-cov q-cov-${tier}`}>{COVERAGE_LABELS[tier]}</span>;
}

export default function Quality({ loaderData }: Route.ComponentProps) {
  const { data } = loaderData;
  if (!data) {
    return (
      <main>
        <Breadcrumbs items={[{ label: 'Анализи', href: '/analytics' }, { label: 'Индекс на качеството' }]} />
        <PageHeader
          kicker="Анализи"
          title="Индекс на качеството"
          lede="Оценките се изчисляват — индексът се попълва от дневната обработка на данните. Опитайте отново по-късно."
        />
      </main>
    );
  }
  const { overview, ranking, contracts, scorecard, scope } = data;

  // Preserve the page state in every internal link (grain/sort/selection/scorecard subject).
  const qs = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const state: Record<string, string | null> = {
      grain: scope.grain === 'authority' ? null : scope.grain,
      sort: scope.sort === 'score' ? null : scope.sort,
      csort: scope.contractSort === 'score' ? null : scope.contractSort,
      sel: scope.sel,
      ...patch,
    };
    for (const [k, v] of Object.entries(state)) if (v != null && v !== '') params.set(k, v);
    const s = params.toString();
    return s ? `/quality?${s}` : '/quality';
  };

  const selRow = scope.sel ? (ranking.find((r) => r.key === scope.sel) ?? null) : null;

  const totals: Total[] = [
    { num: `${score100(overview.avgOverall)}/100`, label: 'среден индекс (оценени договори)' },
    {
      num: overview.totalContracts > 0 ? pct(overview.scoredContracts / overview.totalContracts) : '—',
      label: `оценени договори (${count(overview.scoredContracts)})`,
    },
    {
      num: overview.meanCoverage == null ? '—' : pct(overview.meanCoverage),
      label: 'средно покритие на данните',
    },
  ];

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Индекс на качеството' }]} />
      <main id="main">
        <PageHeader
          kicker="Анализ"
          title={
            <>
              Индекс на <em>качеството</em>
            </>
          }
          lede="Колко здрав е един договор: съставен индекс 0–100 (по-високо = по-здраво) от пет измерения на процеса — конкуренция, откритост, стойност, връзки и прозрачност. Ориентир за преглед, не присъда."
        />

        <Callout title="Какво (не) твърди индексът">
          <p style={{ margin: 0 }}>
            Ниският резултат е <b>сигнал за слабо качество на процеса</b> — не доказателство за
            нарушение. Индексът не открива тръжни картели, необичайно ниски оферти или конфликт на
            интереси; тези данни липсват във фийда. Договор без достатъчно данни е{' '}
            <b>„недостатъчно данни“</b>, никога нула, и не влиза в нито една средна. Всеки резултат е
            проследим до конкретните договори.
          </p>
        </Callout>

        <TotalsStrip totals={totals} label="Обобщение на индекса на качеството" />

        <Section
          id="pillars"
          title={
            <>
              Пет <em>измерения</em>
            </>
          }
          hint="Средни стойности за целия корпус по всяко измерение. Индексът = 0,6 × претеглена средна + 0,4 × най-слабото измерение — слабо звено не се компенсира изцяло от силните."
        >
          <div className="q-pillar-grid">
            {PILLAR_META.map((p) => {
              const v = overview.pillars[p.key];
              return (
                <article className="q-pillar-card" key={p.key}>
                  <header>
                    <span className="q-letter">{p.letter}</span>
                    <span className="q-weight">{Math.round(QUALITY_WEIGHTS[p.key] * 100)}%</span>
                  </header>
                  <h3>{p.name}</h3>
                  <p className={`q-pillar-val q-${band(v)}`}>
                    {score100(v)} <span className="muted">корпус ср.</span>
                  </p>
                  <span className="q-track" aria-hidden="true">
                    <i
                      className={`q-${band(v)}`}
                      style={{ width: `${v == null ? 0 : Math.min(100, v * 100).toFixed(1)}%` }}
                    />
                  </span>
                  <p className="q-pillar-desc">{p.desc}</p>
                </article>
              );
            })}
          </div>
        </Section>

        <Section
          id="methodology"
          title={
            <>
              Как се смята <em>индексът</em>
            </>
          }
          hint="Пет измерения · тегла 30/15/25/20/10 · скала 0–100."
        >
          <div className="q-method">
            <div>
              <h4>Съставяне</h4>
              <ol>
                <li>
                  Във всяко измерение — <b>претеглена средна</b> на наличните показатели.
                </li>
                <li>
                  Между измеренията — <b>0,6 × средна + 0,4 × най-слабото</b>, за да не се „изкупува“
                  слабо звено със силни.
                </li>
                <li>
                  Измерение без никакви данни <b>отпада</b>, а теглата се пренормират до сбор 1.
                </li>
                <li>
                  Сравнението е спрямо <b>група сходни договори</b>: CPV дивизия × стойностен клас ×
                  вид процедура × година.
                </li>
              </ol>
            </div>
            <div>
              <h4>Какво не твърди</h4>
              <ul>
                <li>
                  Ниска оценка е <b>сигнал за слаб процес</b>, не доказана злоупотреба.
                </li>
                <li>
                  Не открива картели, необичайно ниски оферти, скрита собственост или конфликт на
                  интереси — тези данни липсват във фийда.
                </li>
                <li>
                  Всяка оценка е <b>проследима</b> до конкретните договори; няма скрито тегло.
                </li>
              </ul>
            </div>
          </div>

          <h4 className="q-subhead">Какво влиза във всяко измерение</h4>
          <div className="q-leaves-grid">
            {PILLAR_META.map((p) => (
              <div key={p.key}>
                <p className="q-leaves-head">
                  <span className="q-letter small">{p.letter}</span> {p.name}
                </p>
                <ul>
                  {p.leaves.map((leaf) => (
                    <li key={leaf}>{leaf}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="q-method">
            <div>
              <h4>Праг за стойността · value_flag</h4>
              <dl className="q-gate">
                {GATE_ROWS.map((g) => (
                  <div key={g.flag}>
                    <dt className={`q-${g.tone}`}>{g.flag}</dt>
                    <dd>{g.rule}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div>
              <h4>Ниво на увереност · покритие</h4>
              <ul className="q-tiers">
                {COV_TIERS.map((t) => (
                  <li key={t.tier}>
                    <i className={`q-dot q-cov-dot-${t.tier}`} aria-hidden="true" />
                    <span className="q-tier-range">{t.range}</span>
                    <span>{t.label}</span>
                  </li>
                ))}
              </ul>
              <p className="small muted">
                Покритието се докладва до всяка оценка, но никога не влиза в аритметиката ѝ.
              </p>
            </div>
          </div>
        </Section>

        <Section
          id="distribution"
          title={
            <>
              Разпределение на <em>оценките</em>
            </>
          }
          hint="Само оценени договори; договорите без оценка не са нули и стоят извън хистограмата."
        >
          <div className="q-dist">
            <div className="q-dist-chart">
              <Histogram
                histogram={overview.histogram}
                mean={overview.avgOverall}
                scored={overview.scoredContracts}
              />
            </div>
            <div className="q-conf">
              <h4>Ниво на увереност</h4>
              <p className="small muted">Колко пълни са данните зад всяка оценка.</p>
              <ConfidenceMix confidence={overview.confidence} />
              <p className="small muted">
                „Няма оценка“ обхваща договорите с покритие под 0,40 и {count(overview.suspectContracts)}{' '}
                {plural(overview.suspectContracts, 'договор', 'договора')} value_suspect — те се
                изключват от всички средни, не се записват като нула.
              </p>
            </div>
          </div>
        </Section>

        <Section
          id="breakdown"
          title={
            <>
              Разбивка: <em>{GRAIN_TITLES[scope.grain]}</em>
            </>
          }
          hint={
            scope.grain === 'authority' || scope.grain === 'supplier'
              ? `Само редове с поне ${scope.minScored} оценени договора, за да няма шум при малки бройки. Подреждане: най-слабите отгоре.`
              : 'Подреждане: най-слабите отгоре.'
          }
        >
          <nav className="q-grains" aria-label="Разбивка по">
            {GRAIN_OPTIONS.map((g) => (
              <Link
                key={g.key}
                to={qs({ grain: g.key === 'authority' ? null : g.key, sel: null, contract: null })}
                aria-current={scope.grain === g.key ? 'true' : undefined}
              >
                {g.label}
              </Link>
            ))}
            <span className="q-sort">
              Подреди:{' '}
              <Link
                to={qs({ sort: null })}
                aria-current={scope.sort === 'score' ? 'true' : undefined}
              >
                индекс
              </Link>{' '}
              <Link
                to={qs({ sort: 'contracts' })}
                aria-current={scope.sort === 'contracts' ? 'true' : undefined}
              >
                договори
              </Link>
            </span>
          </nav>

          {ranking.length ? (
            <DataTable
              columns={rankColumns(scope.grain, qs)}
              rows={ranking}
              getKey={(r) => r.key}
              caption={`${GRAIN_TITLES[scope.grain]} по индекс на качеството`}
            />
          ) : (
            <p className="muted">
              Няма достатъчно данни за тази разбивка — индексът се преизчислява при всяко обновяване
              на данните.
            </p>
          )}
        </Section>

        <Section
          id="contracts"
          title={
            <>
              Договори · <em>оценки</em>
            </>
          }
          hint={
            selRow ? (
              <>
                Показани са договорите на <b>{selRow.name}</b> ·{' '}
                <Link to={qs({ sel: null, contract: null })}>изчисти избора ✕</Link>
              </>
            ) : (
              'Най-слабите оценки в корпуса. Избери ред от разбивката, за да видиш договорите зад него.'
            )
          }
        >
          <p className="q-sort standalone">
            Подреди:{' '}
            <Link to={qs({ csort: null })} aria-current={scope.contractSort === 'score' ? 'true' : undefined}>
              индекс
            </Link>{' '}
            <Link to={qs({ csort: 'value' })} aria-current={scope.contractSort === 'value' ? 'true' : undefined}>
              стойност
            </Link>
          </p>
          {contracts.length ? (
            <div className="q-contract-grid">
              {contracts.map((c) => (
                <ContractCard
                  key={c.id}
                  c={c}
                  selected={scorecard?.id === c.id}
                  href={`${qs({ contract: c.id })}#scorecard`}
                />
              ))}
            </div>
          ) : (
            <p className="muted">Няма оценени договори за избрания разрез.</p>
          )}
          <p className="small muted">
            Договорите с недостатъчни данни за стойността (value_suspect ·{' '}
            {count(overview.suspectContracts)} в корпуса) не получават оценка и се изключват от всички
            средни — не се записват като нула. Оценката е ориентир за преглед, не заключение.
          </p>
        </Section>

        {scorecard && (
          <Section
            id="scorecard"
            title={
              <>
                Декомпозиция на <em>индекса</em>
              </>
            }
            hint="Карта на оценката за избрания договор — всяко измерение, теглото му и суровите показатели зад него."
          >
            <Scorecard card={scorecard} />
          </Section>
        )}

        <p className="small muted" style={{ marginTop: 'var(--s-3)' }}>
          Показателите са неутрални и описателни, не са оценка на конкретна процедура. Виж{' '}
          <Link to="/methodology#glossary">методологията</Link> за дефинициите.
        </p>
      </main>
    </>
  );
}

function rankColumns(
  grain: QualityGrain,
  qs: (patch: Record<string, string | null>) => string,
): Column<QualityRankRow>[] {
  return [
    { key: 'rank', header: '#', isRank: true, cell: (_r, i) => i + 1 },
    {
      key: 'name',
      header: GRAIN_TITLES[grain],
      isTitle: true,
      cell: (r) => (r.href ? <Link to={r.href}>{r.name}</Link> : r.name),
    },
    {
      key: 'sub',
      header: 'Вид',
      secondary: true,
      cell: (r) => (r.sub ? <Chip>{r.sub}</Chip> : null),
    },
    { key: 'index', header: 'Индекс', align: 'num', cell: (r) => <IndexBar score={r.avgOverall} /> },
    {
      key: 'pillars',
      header: 'Измерения A–E',
      align: 'center',
      cell: (r) => <PillarPills pillars={r.pillars} />,
    },
    {
      key: 'contracts',
      header: 'Оценени',
      align: 'num',
      cell: (r) => (
        <>
          {count(r.scoredContracts)}
          <span className="muted"> / {count(r.totalContracts)}</span>
        </>
      ),
    },
    {
      key: 'coverage',
      header: 'Увереност',
      align: 'center',
      secondary: true,
      cell: (r) => <CovChip tier={r.coverageTier} />,
    },
    {
      key: 'drill',
      header: <span className="sr-only">Договори</span>,
      cell: (r) => (
        <Link className="q-drill" to={`${qs({ sel: r.key, contract: null })}#contracts`}>
          договори ↓
        </Link>
      ),
    },
  ];
}

// SVG histogram — 20 bins over the scored corpus, band-zone underlay, corpus-mean marker. CSS-only
// colors via currentColor classes; no chart library (same spirit as TrendChart/StackedBar).
function Histogram({
  histogram,
  mean,
  scored,
}: {
  histogram: { bin: number; count: number }[];
  mean: number | null;
  scored: number;
}) {
  const W = 600;
  const H = 172;
  const PLOT_BOT = 140;
  const PLOT_TOP = 24;
  const counts = new Array<number>(20).fill(0);
  for (const b of histogram) if (b.bin >= 0 && b.bin < 20) counts[b.bin] = b.count;
  const max = Math.max(1, ...counts);
  const bw = W / 20;
  const zones: { from: number; to: number; label: string; cls: string }[] = [
    { from: 0, to: 0.5, label: 'СЛАБО', cls: 'weak' },
    { from: 0.5, to: 0.7, label: 'СРЕДНО', cls: 'mid' },
    { from: 0.7, to: 1, label: 'ДОБРО', cls: 'good' },
  ];
  return (
    <svg
      className="q-hist"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Хистограма на ${count(scored)} оценени договора по индекс 0–100${mean == null ? '' : `, среден ${score100(mean)}`}`}
    >
      {zones.map((z) => (
        <g key={z.label}>
          <rect
            className={`q-zone q-zone-${z.cls}`}
            x={z.from * W}
            y={6}
            width={(z.to - z.from) * W}
            height={PLOT_BOT - 6}
          />
          <text className={`q-zone-label q-zone-label-${z.cls}`} x={((z.from + z.to) / 2) * W} y={18} textAnchor="middle">
            {z.label}
          </text>
        </g>
      ))}
      {counts.map((c, i) => {
        const h = (c / max) * (PLOT_BOT - PLOT_TOP);
        const mid = (i + 0.5) / 20;
        return (
          <rect
            key={i}
            className={`q-bin q-fill-${band(mid)}`}
            x={i * bw + 1.5}
            y={PLOT_BOT - h}
            width={bw - 3}
            height={h}
            rx={1}
          />
        );
      })}
      <line className="q-axis" x1={0} y1={PLOT_BOT} x2={W} y2={PLOT_BOT} />
      {[0, 25, 50, 75, 100].map((t) => (
        <text key={t} className="q-tick" x={(t / 100) * W} y={156} textAnchor="middle">
          {t}
        </text>
      ))}
      {mean != null && (
        <>
          <line className="q-mean" x1={mean * W} y1={6} x2={mean * W} y2={PLOT_BOT} />
          <text className="q-mean-label" x={mean * W} y={170} textAnchor="middle">
            среден {score100(mean)}
          </text>
        </>
      )}
    </svg>
  );
}

function ConfidenceMix({
  confidence,
}: {
  confidence: { high: number; medium: number; low: number; none: number };
}) {
  const total = confidence.high + confidence.medium + confidence.low + confidence.none;
  if (total === 0) return <p className="muted">Няма данни.</p>;
  const parts: { tier: QualityCoverageTier; n: number }[] = [
    { tier: 'high', n: confidence.high },
    { tier: 'medium', n: confidence.medium },
    { tier: 'low', n: confidence.low },
    { tier: 'none', n: confidence.none },
  ];
  return (
    <>
      <div className="q-confbar" aria-hidden="true">
        {parts
          .filter((p) => p.n > 0)
          .map((p) => (
            <span
              key={p.tier}
              className={`q-cov-fill-${p.tier}`}
              style={{ width: `${((p.n / total) * 100).toFixed(2)}%` }}
            />
          ))}
      </div>
      <ul className="q-conf-legend">
        {parts.map((p) => (
          <li key={p.tier}>
            <i className={`q-dot q-cov-dot-${p.tier}`} aria-hidden="true" />
            <span>{COVERAGE_LABELS[p.tier]}</span>
            <b>{pct(p.n / total)}</b>
          </li>
        ))}
      </ul>
    </>
  );
}

function ContractCard({
  c,
  selected,
  href,
}: {
  c: QualityContractRow;
  selected: boolean;
  href: string;
}) {
  return (
    <article className={`q-card${selected ? ' is-selected' : ''}`}>
      <header>
        <span className="q-card-date">{date(c.signedAt)}</span>
        {c.cpvDivision && <span className="q-card-cpv">CPV {c.cpvDivision}</span>}
        <span className={`q-card-score q-${band(c.overall)}`}>
          {c.overall == null ? '—' : score100(c.overall)}
        </span>
      </header>
      <p className="q-card-buyer">
        <Link to={`/authorities/${c.authoritySlug}`}>{c.authorityName}</Link>
      </p>
      <p className="q-card-seller">
        → <Link to={`/companies/${c.bidderSlug}`}>{c.bidderDisplayName}</Link>
      </p>
      <div className="q-card-row">
        <PillarPills pillars={c.pillars} />
        <span className="q-card-value">
          {money(c.amountEur)}
          <b>стойност</b>
        </span>
      </div>
      <footer>
        <CovChip tier={c.coverageTier} />
        {c.valueFlag === 'value_suspect' ? (
          <span className="q-card-note">value_suspect · без оценка, извън всички средни</span>
        ) : c.valueFlag === 'annex_suspect' ? (
          <span className="q-card-note">annex_suspect · C само от броя анекси</span>
        ) : null}
        <Link className="q-drill" to={href}>
          декомпозиция ↓
        </Link>
      </footer>
    </article>
  );
}

function Scorecard({ card }: { card: QualityScorecard }) {
  const leafRows = scorecardLeaves(card);
  return (
    <div className="q-scorecard">
      <div className="q-sc-head">
        <div className="q-sc-identity">
          <p className="q-card-date">
            {date(card.signedAt)}
            {card.cpvDivision && <span className="q-card-cpv">CPV {card.cpvDivision}</span>}
          </p>
          <p className="q-card-buyer">
            <Link to={`/authorities/${card.authoritySlug}`}>{card.authorityName}</Link>
          </p>
          <p className="q-card-seller">
            → <Link to={`/companies/${card.bidderSlug}`}>{card.bidderDisplayName}</Link>
          </p>
          <p className="q-sc-value">
            {money(card.amountEur)} · <Link to={`/contracts/${card.slug}`}>виж договора</Link>
          </p>
        </div>
        <div className="q-sc-side">
          {card.known && card.worstPillar && (
            <p className="q-sc-worst">
              <span>Най-слабо звено</span>
              <b>{PILLAR_META.find((p) => p.key === card.worstPillar)?.name}</b>
            </p>
          )}
          <p className={`q-sc-conf q-cov-text-${card.coverageTier}`}>
            увереност · {COVERAGE_LABELS[card.coverageTier]}
          </p>
          <div className={`q-sc-ring q-${band(card.overall)}${card.known ? '' : ' is-unknown'}`}>
            <b>{card.known ? score100(card.overall) : '—'}</b>
            <span>{card.known ? '/100' : 'неоценен'}</span>
          </div>
        </div>
      </div>

      {card.known && card.wmean != null && card.worst != null ? (
        <>
          <p className="q-sc-blend">
            претеглена средна <b>{score100(card.wmean)}</b> · най-слабо{' '}
            <b className="q-weak">{score100(card.worst)}</b> · 0,6 × {score100(card.wmean)} + 0,4 ×{' '}
            {score100(card.worst)} ={' '}
            <b className={`q-${band(card.overall)}`}>{score100(card.overall)}</b>
          </p>

          <div className="q-sc-pillars">
            {PILLAR_META.map((p) => {
              const s = card.pillars[p.key];
              const w = card.effectiveWeights[p.key];
              const isWorst = card.worstPillar === p.key;
              return (
                <div className={`q-sc-pillar${isWorst ? ' is-worst' : ''}`} key={p.key}>
                  <header>
                    <span className="q-letter small">{p.letter}</span>
                    <span className="q-weight">
                      {w == null ? 'отпада' : `${Math.round(w * 100)}%`}
                    </span>
                  </header>
                  <h4>{p.name}</h4>
                  <p className={`q-pillar-val q-${band(s)}`}>{score100(s)}</p>
                  <span className="q-track" aria-hidden="true">
                    <i
                      className={`q-${band(s)}`}
                      style={{ width: `${s == null ? 0 : Math.min(100, s * 100).toFixed(1)}%` }}
                    />
                  </span>
                  <dl className="q-sc-leaves">
                    {leafRows[p.key].map((leaf) => (
                      <div key={leaf.k}>
                        <dt>{leaf.k}</dt>
                        <dd>{leaf.v}</dd>
                      </div>
                    ))}
                  </dl>
                  {isWorst && <p className="q-worst-badge">Най-слабо звено</p>}
                </div>
              );
            })}
          </div>

          <p className="q-sc-covflags">
            <span className="q-covflags-label">Покритие</span>
            {[
              { label: 'брой оферти', ok: card.coverageFlags.bids },
              { label: 'дял МСП', ok: card.coverageFlags.sme },
              { label: 'прогнозна стойност', ok: card.coverageFlags.estimate },
              { label: 'текуща стойност', ok: card.coverageFlags.overrun },
            ].map((f) => (
              <span key={f.label} className="q-covflag">
                <b className={f.ok ? 'q-good' : 'q-weak'}>{f.ok ? '✓' : '✕'}</b> {f.label}
              </span>
            ))}
          </p>
          {card.valueFlag === 'annex_suspect' && (
            <p className="q-gate-note">
              <b>Праг:</b> annex_suspect · анекс е раздул текущата стойност → превишението (C2) е
              NULL; стълб C се оценява само от броя анекси.
            </p>
          )}
          {card.valueFlag === 'review' && (
            <p className="q-gate-note">
              <b>Праг:</b> review · сива зона на надценяване — стълб C е умножен по 0,90, а
              увереността е свалена с едно ниво.
            </p>
          )}
        </>
      ) : (
        <p className="q-gate-note">
          {card.valueFlag === 'value_suspect' ? (
            <>
              <b>value_suspect</b> · ефективната стойност надхвърля прага за достоверност. Стълб C =
              NULL, а цялата оценка се задържа като <b>неоценена</b>. Договорът се изключва от всяка
              средна — никога не се записва като нула.
            </>
          ) : (
            <>
              <b>Недостатъчно данни</b> · покритието на този договор е под прага 0,40 (§6.2), затова
              оценката се задържа. Договорът се изключва от всяка средна — никога не се записва като
              нула.
            </>
          )}
        </p>
      )}
    </div>
  );
}

// Raw leaves → display rows per pillar. Missing values render as „—" (unknown, never zero).
function scorecardLeaves(card: QualityScorecard): Record<keyof QualityPillars, { k: string; v: string }[]> {
  const l = card.leaves;
  const num = (v: number | null, dp = 2) =>
    v == null ? '—' : v.toFixed(dp).replace(/\.?0+$/, '').replace('.', ',');
  const yesNo = (v: boolean | null) => (v == null ? '—' : v ? 'да' : 'не');
  return {
    a: [
      {
        k: 'Брой оферти',
        v: l.bidsReceived == null ? '—' : `${l.bidsReceived}${l.singleOffer ? ' · единствена' : ''}`,
      },
      { k: 'Дял МСП', v: l.smeRate == null ? '—' : pct(l.smeRate) },
      { k: 'Електронен търг', v: yesNo(l.isEauction) },
    ],
    b: [
      { k: 'Вид процедура', v: l.procedureType ?? '—' },
      { k: 'Ускорена процедура', v: yesNo(l.isAccelerated) },
      { k: 'Срок за оферти', v: l.bidWindowDays == null ? '—' : `${Math.round(l.bidWindowDays)} дни` },
    ],
    c: [
      { k: 'Брой анекси', v: l.annexCount == null ? '—' : String(l.annexCount) },
      { k: 'Превишение', v: l.costOverrunRatio == null ? '—' : `${num(l.costOverrunRatio)}×` },
      { k: 'Отклонение от прогнозата', v: l.estimateDevRatio == null ? '—' : pct(l.estimateDevRatio) },
    ],
    d: [
      { k: 'HHI на купувача', v: num(l.authorityHhi) },
      { k: 'Дял повторни печалби', v: l.repeatWinIntensity == null ? '—' : pct(l.repeatWinIntensity) },
      { k: 'Възраст на връзката', v: l.edgeAgeYears == null ? '—' : `${num(l.edgeAgeYears, 1)} г.` },
    ],
    e: [
      {
        k: 'Дати',
        v: l.dateFlag == null || l.dateFlag === 'ok' ? 'чисто' : 'подпис преди публикуване',
      },
      {
        k: 'Подизпълнение',
        v: l.subcontractPassthrough == null ? '—' : pct(l.subcontractPassthrough),
      },
      { k: 'Срок', v: l.durationDays == null ? '—' : `${count(l.durationDays)} дни` },
    ],
  };
}
