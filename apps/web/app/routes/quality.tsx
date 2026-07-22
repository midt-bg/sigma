import { Form, Link } from 'react-router';
import type {
  QualityContractRow,
  QualityCoverageTier,
  QualityGrain,
  QualityPillars,
  QualityRankDir,
  QualityRankRow,
  QualityRankSort,
  QualityScorecard,
} from '@sigma/api-contract';
import { count, date, money, pct, plural } from '@sigma/shared';
import { getQuality, QUALITY_WEIGHTS, qualityRankDefaultDir } from '@sigma/db';
import type { Route } from './+types/quality';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { DataTable, type Column } from '../components/DataTable';
import { MetricInfo } from '../components/MetricInfo';
import { TotalsStrip, type Total } from '../components/TotalsStrip';
import { Callout, Chip, Section } from '../components/ui';
import { publicCache } from '../lib/cache';
import { isMissingDerivedTableError } from '../lib/etl';
import { qualityRankingControls } from '../lib/filters';
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

// Header-hint reading order per sort key × direction („Подреждане: …“).
const DIR_HINTS: Record<QualityRankSort, Record<QualityRankDir, string>> = {
  score: { asc: 'най-слабите отгоре', desc: 'най-добрите отгоре' },
  contracts: { desc: 'най-много договори отгоре', asc: 'най-малко договори отгоре' },
};

const COVERAGE_LABELS: Record<QualityCoverageTier, string> = {
  high: 'Високо',
  medium: 'Средно',
  low: 'Ниско',
  none: 'Няма оценка',
};

// §3.4 value_flag gate — static reference rows (the ETL applies these before any pillar is scored).
const GATE_ROWS: { flag: string; tone: 'good' | 'mid' | 'weak'; rule: string }[] = [
  { flag: 'ok', tone: 'good', rule: 'чист договор — оценяват се всички измерения.' },
  {
    flag: 'review',
    tone: 'mid',
    rule: 'сива зона на надценяване — стълб C × 0,90; увереност −1 ниво.',
  },
  {
    flag: 'value_low',
    tone: 'mid',
    rule: 'нулева/нищожна стойност — точността на прогнозата (C3) става NULL.',
  },
  {
    flag: 'annex_suspect',
    tone: 'weak',
    rule: 'анекс е раздул стойността — превишението (C2) става NULL; C от анексите.',
  },
  {
    flag: 'value_suspect',
    tone: 'weak',
    rule: 'извън прага за достоверност — цял C = NULL и договорът е НЕОЦЕНЕН, извън средните.',
  },
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
  // „Разбивка" ranking controls come from the shared parser (validated before they can shape a
  // cache key or a query — CWE-349); the db layer re-validates at its own boundary.
  const rank = qualityRankingControls(sp);
  const grainParam = sp.get('grain');
  const grain = GRAIN_OPTIONS.some((g) => g.key === grainParam)
    ? (grainParam as QualityGrain)
    : undefined;
  let data = null;
  try {
    data = await getQuality(db, {
      grain,
      sort: sp.get('sort') === 'contracts' ? 'contracts' : 'score',
      dir: rank.rankDir,
      contractSort: sp.get('csort') === 'value' ? 'value' : 'score',
      sel: sp.get('sel'),
      contractId: sp.get('contract'),
      band: sp.get('band'),
      rankFrom: rank.rankFrom,
      rankTo: rank.rankTo,
    });
  } catch (err) {
    // The health tables are built by the daily ETL (ship-domain rebuilds contract_features
    // DROP+CREATE); before the first derive — or mid-rebuild — they may not exist yet.
    if (!isMissingDerivedTableError(err)) {
      console.error('[quality] getQuality failed', err);
      throw err;
    }
    console.warn('[quality] quality tables not yet derived, showing empty state', err);
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

// Display label of a validated ?band value (bin index '0'–'19' or a named zone) on the 0–100 scale.
const ZONE_BAND_LABELS: Record<string, string> = {
  weak: 'слабо (0–49)',
  mid: 'средно (50–69)',
  good: 'добро (70–100)',
};
function bandLabel(b: string): string {
  if (/^\d+$/.test(b)) {
    const i = Number(b);
    return `${i * 5}–${(i + 1) * 5}`;
  }
  return ZONE_BAND_LABELS[b] ?? b;
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
          <span
            key={p.key}
            className="q-pill"
            title={`${p.name}: ${v == null ? 'няма данни' : score100(v)}`}
          >
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
      <main id="main">
        <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Индекс на качеството' }]} />
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
  const defaultDir = qualityRankDefaultDir(scope.sort);
  // ?rdir is written only when it differs from the sort key's default, so canonical URLs stay clean.
  const rdirParam = scope.sortDir === defaultDir ? null : scope.sortDir;
  const rangeActive = scope.rankFrom != null || scope.rankTo != null;
  const qs = (patch: Record<string, string | number | null>) => {
    const params = new URLSearchParams();
    const state: Record<string, string | number | null> = {
      grain: scope.grain === 'authority' ? null : scope.grain,
      sort: scope.sort === 'score' ? null : scope.sort,
      rdir: rdirParam,
      rfrom: scope.rankFrom,
      rto: scope.rankTo,
      csort: scope.contractSort === 'score' ? null : scope.contractSort,
      sel: scope.sel,
      band: scope.band,
      contract: scope.contractId,
      ...patch,
    };
    for (const [k, v] of Object.entries(state)) if (v != null && v !== '') params.set(k, String(v));
    const s = params.toString();
    return s ? `/quality?${s}` : '/quality';
  };

  const selRow = scope.sel ? (ranking.find((r) => r.key === scope.sel) ?? null) : null;

  const totals: Total[] = [
    { num: `${score100(overview.avgOverall)}/100`, label: 'среден индекс (оценени договори)' },
    {
      num:
        overview.totalContracts > 0 ? pct(overview.scoredContracts / overview.totalContracts) : '—',
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
            <b>„недостатъчно данни“</b>, никога нула, и не влиза в нито една средна. Всеки резултат
            е проследим до конкретните договори.
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
                  Между измеренията — <b>0,6 × средна + 0,4 × най-слабото</b>, за да не се
                  „изкупува“ слабо звено със силни.
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
              <MetricInfo
                title="Разпределение"
                summary="Хистограма на оценените договори по индекс 0–100 в 20 интервала по 5 точки. Договор без достатъчно данни не участва — той е „недостатъчно данни“, никога нула. Клик върху стълб или зона филтрира списъка с договори по този диапазон."
                readout={`${count(overview.scoredContracts)} оценени договора · 20 интервала × 5 точки`}
              />
            </>
          }
          hint="Само оценени договори; договорите без оценка не са нули и стоят извън хистограмата. Клик върху стълб или зона показва договорите в диапазона."
        >
          <div className="q-dist">
            <div className="q-dist-chart">
              <Histogram
                histogram={overview.histogram}
                mean={overview.avgOverall}
                scored={overview.scoredContracts}
                selBand={scope.band}
                hrefFor={(b) => `${qs({ band: b })}#distribution`}
              />
              {scope.band && (
                <p className="q-band-chip">
                  <span>
                    Филтър: индекс <b>{bandLabel(scope.band)}</b>
                  </span>
                  <Link to={`${qs({ band: null })}#distribution`}>изчисти ✕</Link>
                </p>
              )}
            </div>
            <div className="q-conf">
              <h4>Ниво на увереност</h4>
              <p className="small muted">Колко пълни са данните зад всяка оценка.</p>
              <ConfidenceMix confidence={overview.confidence} />
              <p className="small muted">
                „Няма оценка“ обхваща договорите с покритие под 0,40 и{' '}
                {count(overview.suspectContracts)}{' '}
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
              ? `Само редове с поне ${scope.minScored} оценени договора, за да няма шум при малки бройки. Подреждане: ${DIR_HINTS[scope.sort][scope.sortDir]}.`
              : `Подреждане: ${DIR_HINTS[scope.sort][scope.sortDir]}.`
          }
        >
          <nav className="q-grains" aria-label="Разбивка по">
            {GRAIN_OPTIONS.map((g) => (
              <Link
                key={g.key}
                to={qs({ grain: g.key === 'authority' ? null : g.key, sel: null, contract: null })}
                aria-current={scope.grain === g.key ? 'true' : undefined}
                preventScrollReset
              >
                {g.label}
              </Link>
            ))}
            <span className="q-sort">
              Подреди:{' '}
              <Link
                to={qs({ sort: null, rdir: null })}
                aria-current={scope.sort === 'score' ? 'true' : undefined}
                preventScrollReset
              >
                индекс
              </Link>{' '}
              <Link
                to={qs({ sort: 'contracts', rdir: null })}
                aria-current={scope.sort === 'contracts' ? 'true' : undefined}
                preventScrollReset
              >
                договори
              </Link>
              {' · '}
              <Link
                to={qs({ rdir: defaultDir === 'asc' ? null : 'asc' })}
                aria-current={scope.sortDir === 'asc' ? 'true' : undefined}
                aria-label={`Възходящо — ${DIR_HINTS[scope.sort].asc}`}
                title={`Възходящо — ${DIR_HINTS[scope.sort].asc}.`}
                preventScrollReset
              >
                ↑
              </Link>{' '}
              <Link
                to={qs({ rdir: defaultDir === 'desc' ? null : 'desc' })}
                aria-current={scope.sortDir === 'desc' ? 'true' : undefined}
                aria-label={`Низходящо — ${DIR_HINTS[scope.sort].desc}`}
                title={`Низходящо — ${DIR_HINTS[scope.sort].desc}.`}
                preventScrollReset
              >
                ↓
              </Link>
            </span>
          </nav>

          {/* Avg-index range over the rollup rows (0–100 display scale). Plain GET form (no-JS
              friendly); a new range recomputes the ranking from the top. */}
          <Form
            method="get"
            className="flow-controls q-range"
            role="group"
            aria-label="Диапазон по среден индекс"
            preventScrollReset
          >
            {scope.grain !== 'authority' && (
              <input type="hidden" name="grain" value={scope.grain} />
            )}
            {scope.sort !== 'score' && <input type="hidden" name="sort" value={scope.sort} />}
            {rdirParam && <input type="hidden" name="rdir" value={rdirParam} />}
            {scope.contractSort !== 'score' && (
              <input type="hidden" name="csort" value={scope.contractSort} />
            )}
            {scope.sel && <input type="hidden" name="sel" value={scope.sel} />}
            {scope.band && <input type="hidden" name="band" value={scope.band} />}
            {scope.contractId && <input type="hidden" name="contract" value={scope.contractId} />}
            <span className="q-range-label">
              Индекс
              <MetricInfo
                title="Диапазон по индекс"
                summary="Филтрира редовете по средния им индекс (0–100)."
              />
            </span>
            <label>
              От:
              <input
                type="number"
                name="rfrom"
                min={0}
                max={100}
                step={1}
                inputMode="numeric"
                defaultValue={scope.rankFrom ?? ''}
              />
            </label>
            <label>
              До:
              <input
                type="number"
                name="rto"
                min={0}
                max={100}
                step={1}
                inputMode="numeric"
                defaultValue={scope.rankTo ?? ''}
              />
            </label>
            <button type="submit">Приложи</button>
            {rangeActive && (
              <Link to={qs({ rfrom: null, rto: null })} preventScrollReset>
                индекс {scope.rankFrom ?? 0}–{scope.rankTo ?? 100} ✕
              </Link>
            )}
          </Form>

          <p className="sr-only" role="status">
            {`Разбивка: ${count(ranking.length)} ${plural(ranking.length, 'ред', 'реда')}${
              rangeActive ? ` · филтър по индекс ${scope.rankFrom ?? 0}–${scope.rankTo ?? 100}` : ''
            }.`}
          </p>
          {ranking.length ? (
            <DataTable
              columns={rankColumns(scope.grain, qs)}
              rows={ranking}
              getKey={(r) => r.key}
              caption={`${GRAIN_TITLES[scope.grain]} по индекс на качеството`}
            />
          ) : (
            <p className="muted">
              {rangeActive ? (
                <>
                  Няма редове със среден индекс {scope.rankFrom ?? 0}–{scope.rankTo ?? 100} в тази
                  разбивка.{' '}
                  <Link to={qs({ rfrom: null, rto: null })} preventScrollReset>
                    Изчисти диапазона ✕
                  </Link>
                </>
              ) : (
                'Няма достатъчно данни за тази разбивка — индексът се преизчислява при всяко обновяване на данните.'
              )}
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
            <Link
              to={qs({ csort: null })}
              aria-current={scope.contractSort === 'score' ? 'true' : undefined}
              preventScrollReset
            >
              индекс
            </Link>{' '}
            <Link
              to={qs({ csort: 'value' })}
              aria-current={scope.contractSort === 'value' ? 'true' : undefined}
              preventScrollReset
            >
              стойност
            </Link>
            {scope.band && (
              <>
                {' · '}
                <span className="q-band-tag">индекс {bandLabel(scope.band)}</span>{' '}
                <Link to={qs({ band: null })}>✕</Link>
              </>
            )}
          </p>
          <p className="sr-only" role="status">
            {`Показани ${count(contracts.length)} ${plural(contracts.length, 'договор', 'договора')}${
              scope.band ? ` · филтър по индекс ${bandLabel(scope.band)}` : ''
            }.`}
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
            <p className="muted">
              Няма оценени договори за избрания разрез.{' '}
              {scope.band && <Link to={qs({ band: null })}>Изчисти филтъра по индекс</Link>}
            </p>
          )}
          <p className="small muted">
            Договорите с недостатъчни данни за стойността (value_suspect ·{' '}
            {count(overview.suspectContracts)} в корпуса) не получават оценка и се изключват от
            всички средни — не се записват като нула. Оценката е ориентир за преглед, не заключение.
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
    {
      key: 'index',
      header: 'Индекс',
      align: 'num',
      cell: (r) => <IndexBar score={r.avgOverall} />,
    },
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
// colors via currentColor classes; no chart library (same spirit as TrendChart/StackedBar). Every
// bin and zone label is a plain GET link (no-JS friendly) that filters the contracts list below to
// that score band (?band=…); clicking the active bin/zone clears the filter again. Tooltips are
// native SVG <title> children — the page's existing title-attr pattern, no separate tooltip style.
function Histogram({
  histogram,
  mean,
  scored,
  selBand,
  hrefFor,
}: {
  histogram: { bin: number; count: number }[];
  mean: number | null;
  scored: number;
  selBand: string | null;
  hrefFor: (band: string | null) => string;
}) {
  const W = 600;
  const H = 248;
  const PLOT_BOT = 210;
  const PLOT_TOP = 28;
  const counts = new Array<number>(20).fill(0);
  for (const b of histogram) if (b.bin >= 0 && b.bin < 20) counts[b.bin] = b.count;
  const max = Math.max(1, ...counts);
  const bw = W / 20;
  const share = (n: number) => (scored > 0 ? pct(n / scored) : '—');
  const zones: { key: 'weak' | 'mid' | 'good'; from: number; to: number; label: string }[] = [
    { key: 'weak', from: 0, to: 0.5, label: 'СЛАБО' },
    { key: 'mid', from: 0.5, to: 0.7, label: 'СРЕДНО' },
    { key: 'good', from: 0.7, to: 1, label: 'ДОБРО' },
  ];
  const zoneCount = (z: { from: number; to: number }) =>
    counts.reduce((t, c, i) => (i / 20 >= z.from && i / 20 < z.to ? t + c : t), 0);
  // Is bin i inside the current selection? (a selected zone highlights all of its bins)
  const inSel = (i: number) =>
    selBand != null &&
    (selBand === String(i) ||
      (selBand === 'weak' && i < 10) ||
      (selBand === 'mid' && i >= 10 && i < 14) ||
      (selBand === 'good' && i >= 14));
  return (
    <svg
      className={`q-hist${selBand ? ' has-band' : ''}`}
      viewBox={`0 0 ${W} ${H}`}
      role="group"
      aria-label={`Хистограма на ${count(scored)} оценени договора по индекс 0–100${mean == null ? '' : `, среден ${score100(mean)}`}. Клик върху стълб филтрира списъка с договори.`}
    >
      {zones.map((z) => (
        <rect
          key={z.key}
          className={`q-zone q-zone-${z.key}`}
          x={z.from * W}
          y={6}
          width={(z.to - z.from) * W}
          height={PLOT_BOT - 6}
        />
      ))}
      {counts.map((c, i) => {
        const h = (c / max) * (PLOT_BOT - PLOT_TOP);
        const mid = (i + 0.5) / 20;
        return (
          <a
            key={i}
            href={hrefFor(selBand === String(i) ? null : String(i))}
            className="q-bin-link"
            aria-current={selBand === String(i) ? 'true' : undefined}
          >
            <title>{`Индекс ${i * 5}–${(i + 1) * 5}: ${count(c)} ${plural(c, 'договор', 'договора')} · ${share(c)} от оценените — клик за филтър.`}</title>
            {/* full-height invisible hit area so even a near-empty bin stays clickable */}
            <rect className="q-bin-hit" x={i * bw} y={6} width={bw} height={PLOT_BOT - 6} />
            <rect
              className={`q-bin q-fill-${band(mid)}${inSel(i) ? ' is-selected' : ''}`}
              x={i * bw + 1.5}
              y={PLOT_BOT - h}
              width={bw - 3}
              height={h}
              rx={1}
            />
          </a>
        );
      })}
      {/* Zone labels render after the bins (SVG paints later elements on top) so their small
          click/title target sits above the bins' full-height hit rects instead of being
          shadowed by them. */}
      {zones.map((z) => (
        <a
          key={z.key}
          href={hrefFor(selBand === z.key ? null : z.key)}
          className="q-zone-link"
          aria-current={selBand === z.key ? 'true' : undefined}
        >
          <title>{`Зона „${ZONE_BAND_LABELS[z.key]}“: ${count(zoneCount(z))} ${plural(zoneCount(z), 'договор', 'договора')} · ${share(zoneCount(z))} от оценените — клик за филтър.`}</title>
          <text
            className={`q-zone-label q-zone-label-${z.key}`}
            x={((z.from + z.to) / 2) * W}
            y={20}
            textAnchor="middle"
          >
            {z.label}
          </text>
        </a>
      ))}
      <line className="q-axis" x1={0} y1={PLOT_BOT} x2={W} y2={PLOT_BOT} />
      {[0, 25, 50, 75, 100].map((t) => (
        <text key={t} className="q-tick" x={(t / 100) * W} y={PLOT_BOT + 16} textAnchor="middle">
          {t}
        </text>
      ))}
      {mean != null && (
        <g>
          <title>{`Среден индекс на оценените договори: ${score100(mean)} от 100.`}</title>
          <line className="q-mean" x1={mean * W} y1={6} x2={mean * W} y2={PLOT_BOT} />
          <text className="q-mean-label" x={mean * W} y={PLOT_BOT + 34} textAnchor="middle">
            среден {score100(mean)}
          </text>
        </g>
      )}
    </svg>
  );
}

// One-sentence hover explanations for the confidence tiers (§6.2 coverage bands).
const COV_TITLES: Record<QualityCoverageTier, string> = {
  high: 'Покритие на данните ≥ 0,80 — оценката се публикува без уговорки.',
  medium: 'Покритие на данните 0,60–0,79 — оценката се публикува.',
  low: 'Покритие на данните 0,40–0,59 — оценката се публикува с уговорка.',
  none: 'Покритие под 0,40 или недостоверна стойност — договорът остава без оценка, никога нула.',
};

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
          <li key={p.tier} title={COV_TITLES[p.tier]}>
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
function scorecardLeaves(
  card: QualityScorecard,
): Record<keyof QualityPillars, { k: string; v: string }[]> {
  const l = card.leaves;
  const num = (v: number | null, dp = 2) =>
    v == null
      ? '—'
      : v
          .toFixed(dp)
          .replace(/\.?0+$/, '')
          .replace('.', ',');
  const yesNo = (v: boolean | null) => (v == null ? '—' : v ? 'да' : 'не');
  return {
    a: [
      {
        k: 'Брой оферти',
        v:
          l.bidsReceived == null ? '—' : `${l.bidsReceived}${l.singleOffer ? ' · единствена' : ''}`,
      },
      { k: 'Дял МСП', v: l.smeRate == null ? '—' : pct(l.smeRate) },
      { k: 'Електронен търг', v: yesNo(l.isEauction) },
    ],
    b: [
      { k: 'Вид процедура', v: l.procedureType ?? '—' },
      { k: 'Ускорена процедура', v: yesNo(l.isAccelerated) },
      {
        k: 'Срок за оферти',
        v: l.bidWindowDays == null ? '—' : `${Math.round(l.bidWindowDays)} дни`,
      },
    ],
    c: [
      { k: 'Брой анекси', v: l.annexCount == null ? '—' : String(l.annexCount) },
      { k: 'Превишение', v: l.costOverrunRatio == null ? '—' : `${num(l.costOverrunRatio)}×` },
      {
        k: 'Отклонение от прогнозата',
        v: l.estimateDevRatio == null ? '—' : pct(l.estimateDevRatio),
      },
    ],
    d: [
      { k: 'HHI на купувача', v: num(l.authorityHhi) },
      {
        k: 'Дял повторни печалби',
        v: l.repeatWinIntensity == null ? '—' : pct(l.repeatWinIntensity),
      },
      {
        k: 'Възраст на връзката',
        v: l.edgeAgeYears == null ? '—' : `${num(l.edgeAgeYears, 1)} г.`,
      },
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
