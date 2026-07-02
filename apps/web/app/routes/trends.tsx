import { Link, useNavigation, useSearchParams } from 'react-router';
import type { CpvGroupStat, TrendGranularity } from '@sigma/api-contract';
import { count, date as fmtDate, money, plural } from '@sigma/shared';
import {
  getCpvGroupMedians,
  getCpvGroupStats,
  getSpendingTrend,
  listOverviewContracts,
} from '@sigma/db';
import type { Route } from './+types/trends';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { TotalsStrip, type Total } from '../components/TotalsStrip';
import { ComboTrendChart } from '../components/ComboTrendChart';
import { Callout } from '../components/ui';
import { publicCache } from '../lib/cache';
import { cpvGroupSelection, singleSelectFilters } from '../lib/filters';

// „Договори — обзор": one list of contracts looked at from three angles (lenses) — in time, per CPV
// group, or both at once. Every control is a plain <Link> mutating the query string, so the page is
// fully SSR/no-JS capable; the only hydrated behavior is the chart hover tooltip.

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Договори — обзор — СИГМА' },
    {
      name: 'description',
      content:
        'Един и същи списък договори — сортиран по време, срязан по CPV код, или двете наведнъж. Обем и брой по месеци, тримесечия и години; типични цени по CPV групи.',
    },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

type Angle = 'time' | 'cpv' | 'cross';
type Step = 'm' | 'q' | 'y';

function pick<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return raw != null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

const STEP_GRANULARITY: Record<Step, TrendGranularity> = {
  m: 'month',
  q: 'quarter',
  y: 'year',
};

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const db = context.cloudflare.env.DB;

  const angle = pick<Angle>(sp.get('angle'), ['time', 'cpv', 'cross'], 'time');
  const step = pick<Step>(sp.get('step'), ['m', 'q', 'y'], 'q');
  const sort = pick(sp.get('sort'), ['date', 'value'] as const, 'date');
  const cpvSort = pick(sp.get('cpvSort'), ['n', 'med', 'code'] as const, 'n');
  const yearRaw = sp.get('year');
  const year = yearRaw && /^20\d\d$/.test(yearRaw) ? yearRaw : null;
  // Repeatable ?cpv — the multi-select CPV facet. Validated + bounded by cpvGroupSelection so
  // hostile input can neither poison the SQL scope nor mint unbounded cache-key variants (CWE-349).
  const cpvSel = cpvGroupSelection(sp);

  // The cross lens always shows the compact quarterly picker; the time lens follows the step toggle.
  const granularity = angle === 'cross' ? 'quarter' : STEP_GRANULARITY[step];

  const [trend, stats, contracts] = await Promise.all([
    // Faceted by the selected CPV groups (one aggregate scan; all groups when nothing is selected),
    // so the combo chart, year cards and totals all re-run server-side on real data.
    getSpendingTrend(db, { granularity, cpvGroups: cpvSel }, { includeSectors: false }),
    getCpvGroupStats(db, 10),
    listOverviewContracts(db, { year, cpvGroups: cpvSel, sort, limit: 24 }),
  ]);

  // „Спрямо типичното" baselines for card groups outside the top-N stats (bounded: distinct groups
  // on one card page, plus the selected group so its filter chip can carry a name).
  const known = new Set(stats.groups.map((g) => g.group));
  const missing = contracts
    .map((c) => c.cpvGroup)
    .filter((g): g is string => g != null && !known.has(g));
  for (const g of cpvSel) if (!known.has(g)) missing.push(g);
  const medians = await getCpvGroupMedians(db, missing);

  return { angle, step, sort, cpvSort, year, cpvSel, trend, stats, contracts, medians };
}

// ── Presentational helpers ────────────────────────────────────────────────────────────────────────

/** ×N with a Bulgarian decimal comma: 2.4 → '×2,4', 15 → '×15'. */
function multText(mult: number): string {
  if (mult >= 10) return `×${Math.round(mult)}`;
  return `×${(Math.round(mult * 10) / 10).toString().replace('.', ',')}`;
}

function relLabel(valueEur: number, medianEur: number): { text: string; cls: string } {
  const mult = valueEur / medianEur;
  if (mult >= 1.3) return { text: `${multText(mult)} типичното`, cls: 'ov-rel-hi' };
  if (mult <= 0.75) return { text: 'под типичното', cls: 'ov-rel-lo' };
  return { text: '≈ типичното', cls: 'ov-rel-mid' };
}

// Deterministic jitter for the dot cloud (presentation only — the x positions are real values).
function jitter(seedText: string, i: number): number {
  let h = 2166136261;
  for (const ch of `${seedText}:${i}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 8) % 1000) / 1000 - 0.5;
}

const LOG_MIN = 1e3;

function logMax(groups: CpvGroupStat[]): number {
  const max = Math.max(1e6, ...groups.map((g) => g.maxEur));
  return 10 ** Math.ceil(Math.log10(max));
}

function axisLabel(v: number): string {
  return v >= 1e6 ? `${v / 1e6}М` : `${v / 1e3}к`;
}

/** log-€ → x in the 320-wide distribution strip. */
function makeLx(gMax: number) {
  const lo = Math.log10(LOG_MIN);
  const hi = Math.log10(gMax);
  return (v: number) =>
    6 + ((Math.log10(Math.min(gMax, Math.max(LOG_MIN, v))) - lo) / (hi - lo)) * 308;
}

// Per-group distribution strip: p10–p90 box, real-value dot cloud (log x), median line. Dots at
// ≥5× the group median are highlighted — the same "worth a look" cue as the card labels.
function DistStrip({ g, gMax }: { g: CpvGroupStat; gMax: number }) {
  const lx = makeLx(gMax);
  return (
    <svg viewBox="0 0 320 30" className="ov-dist" aria-hidden="true">
      <line className="ov-dist-axis" x1={6} y1={16} x2={314} y2={16} />
      <rect
        className="ov-dist-box"
        x={lx(g.p10Eur).toFixed(1)}
        y={11}
        width={Math.max(0, lx(g.p90Eur) - lx(g.p10Eur)).toFixed(1)}
        height={10}
        rx={2}
      />
      {g.sampleEur.map((v, i) => {
        const hi = v >= g.medianEur * 5;
        return (
          <circle
            key={i}
            className={hi ? 'ov-dot is-outlier' : 'ov-dot'}
            cx={lx(v).toFixed(1)}
            cy={(16 + jitter(g.group, i) * 15).toFixed(1)}
            r={hi ? 3 : 2}
          />
        );
      })}
      <line
        className="ov-dist-median"
        x1={lx(g.medianEur).toFixed(1)}
        y1={4}
        x2={lx(g.medianEur).toFixed(1)}
        y2={28}
      />
    </svg>
  );
}

function DistAxis({ gMax }: { gMax: number }) {
  const lx = makeLx(gMax);
  const ticks: number[] = [];
  for (let v = LOG_MIN; v <= gMax; v *= 10) ticks.push(v);
  return (
    <svg viewBox="0 0 320 16" className="ov-dist ov-dist-ticks" aria-hidden="true">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={lx(v).toFixed(1)} y1={0} x2={lx(v).toFixed(1)} y2={4} />
          <text x={lx(v).toFixed(1)} y={13} textAnchor="middle">
            {axisLabel(v)}
          </text>
        </g>
      ))}
    </svg>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────────────────────────

export default function Trends({ loaderData }: Route.ComponentProps) {
  const { angle, step, sort, cpvSort, year, cpvSel, trend, stats, contracts, medians } = loaderData;
  const [sp] = useSearchParams();
  const navigating = useNavigation().state !== 'idle';

  // Every control is a Link that patches the query string (null deletes a key; an array replaces
  // every occurrence of a repeatable key — the CPV multi-select).
  const hrefWith = (patch: Record<string, string | string[] | null>): string => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      next.delete(k);
      if (Array.isArray(v)) for (const item of v) next.append(k, item);
      else if (v != null) next.set(k, v);
    }
    const qs = next.toString();
    return qs ? `/trends?${qs}` : '/trends';
  };

  // Toggle one CPV group in/out of the multi-select (a plain GET Link — no-JS friendly). The set is
  // written sorted so equal selections always share one canonical URL/edge-cache key.
  const hrefToggleCpv = (group: string): string => {
    const next = (
      cpvSel.includes(group) ? cpvSel.filter((g) => g !== group) : [...cpvSel, group]
    ).sort();
    return hrefWith({ cpv: next.length ? next : null });
  };

  // Cohort baseline per CPV group: top-N stats first, on-demand medians for the rest.
  const cohorts = new Map<string, { name: string | null; medianEur: number }>();
  for (const m of medians) cohorts.set(m.group, { name: m.name, medianEur: m.medianEur });
  for (const g of stats.groups) cohorts.set(g.group, { name: g.name, medianEur: g.medianEur });

  const datedContracts = trend.points.reduce((sum, p) => sum + p.contracts, 0);
  const totals: Total[] = [
    { num: money(trend.totalValueEur), label: 'обща стойност' },
    { num: count(datedContracts), label: 'договора' },
    { num: count(stats.totalGroups), label: 'CPV групи' },
  ];

  const gMax = logMax(stats.groups);
  const cpvRows = [...stats.groups].sort((a, b) =>
    cpvSort === 'med'
      ? b.medianEur - a.medianEur
      : cpvSort === 'code'
        ? a.group.localeCompare(b.group)
        : b.contracts - a.contracts,
  );

  const chips: { label: string; clear: Record<string, string | string[] | null> }[] = [];
  for (const g of cpvSel) {
    const rest = cpvSel.filter((c) => c !== g);
    chips.push({ label: `CPV ${g}`, clear: { cpv: rest.length ? rest : null } });
  }
  if (year) chips.push({ label: year, clear: { year: null } });
  const lensHint =
    angle === 'time'
      ? 'кликни година, за да филтрираш'
      : angle === 'cpv'
        ? 'кликни CPV ред, за да филтрираш'
        : 'избери година и CPV код';

  const scopeParts: string[] = [];
  for (const g of cpvSel) scopeParts.push(`CPV ${g}`);
  if (year) scopeParts.push(year);
  const scopeText = scopeParts.length ? scopeParts.join(' · ') : 'всички договори';

  const angles: { key: Angle; label: string }[] = [
    { key: 'time', label: 'Във времето' },
    { key: 'cpv', label: 'По CPV код' },
    { key: 'cross', label: 'Време × CPV' },
  ];
  const steps: { key: Step; label: string }[] = [
    { key: 'm', label: 'Мес.' },
    { key: 'q', label: 'Трим.' },
    { key: 'y', label: 'Год.' },
  ];
  const cpvSorts = [
    { key: 'n', label: 'Договори' },
    { key: 'med', label: 'Типична' },
    { key: 'code', label: 'CPV' },
  ] as const;
  const sorts = [
    { key: 'date', label: 'Най-нови' },
    { key: 'value', label: 'Стойност' },
  ] as const;

  const yearCards = trend.years.map((y) => ({
    ...y,
    active: y.year === year,
    href: hrefWith({ year: y.year === year ? null : y.year }),
  }));

  const cpvPanel = (compact: boolean) => (
    <div className="ovz-panel ov-cpv" data-compact={compact || undefined}>
      <div className="ov-panel-head">
        <div>
          <h2 className="ovz-panel-title">
            {compact ? (
              <>
                Стеснѝ по <em>CPV код</em>
              </>
            ) : (
              <>
                Цени по <em>CPV код</em>
              </>
            )}
          </h2>
          {!compact && (
            <p className="ov-panel-hint">
              Всеки код събира сходни поръчки. Разсейването е нормално — обемите варират. Кликни
              ред, за да видиш договорите. Показани са {stats.groups.length}-те групи с най-много
              договори.
            </p>
          )}
        </div>
        {!compact && (
          <div className="ovz-seg" role="group" aria-label="Подредба на CPV групите">
            {cpvSorts.map((s) => (
              <Link
                key={s.key}
                to={hrefWith({ cpvSort: s.key === 'n' ? null : s.key })}
                preventScrollReset
                aria-current={cpvSort === s.key || undefined}
              >
                {s.label}
              </Link>
            ))}
          </div>
        )}
      </div>
      {!compact && (
        <div className="ov-cpv-head" aria-hidden="true">
          <span>CPV</span>
          <span>Категория</span>
          <span className="num">Типична</span>
          <span className="num">Догов.</span>
          <span>Разпределение · лог €</span>
        </div>
      )}
      {cpvRows.map((g) => {
        const active = cpvSel.includes(g.group);
        return (
          <Link
            key={g.group}
            to={hrefToggleCpv(g.group)}
            preventScrollReset
            className={`ov-cpv-row${active ? ' is-active' : ''}`}
            aria-current={active || undefined}
          >
            {compact && (
              <span className="ov-check" aria-hidden="true">
                {active ? '✓' : ''}
              </span>
            )}
            <span className="ov-cpv-code mono">{g.group}</span>
            <span className="ov-cpv-name">
              <span className="clamp">{g.name ?? `CPV група ${g.group}`}</span>
              {!compact && (
                <span className="ov-cpv-range">
                  диапазон p10–p90 · {money(g.p10Eur)} – {money(g.p90Eur)}
                </span>
              )}
            </span>
            <span className="ov-cpv-med mono">{money(g.medianEur)}</span>
            {!compact && (
              <>
                <span className="ov-cpv-n mono">{count(g.contracts)}</span>
                <DistStrip g={g} gMax={gMax} />
              </>
            )}
          </Link>
        );
      })}
      {!compact && (
        <div className="ov-cpv-foot">
          <DistAxis gMax={gMax} />
        </div>
      )}
    </div>
  );

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Договори — обзор' }]} />
      <main id="main">
        <PageHeader
          kicker="Обзор на договорите"
          title={
            <>
              Договори, погледнати под <em>различен ъгъл</em>
            </>
          }
          lede="Един и същи списък договори — сортиран по време, срязан по CPV код, или двете наведнъж. Изберѝ ъгъл; списъкът долу се сглобява от избора. Договорите без валидна дата или стойност не влизат в изгледа."
        />

        <TotalsStrip totals={totals} label="Обобщение на обзора" />

        <nav className="ov-controls" aria-label="Ъгъл на гледане и филтри">
          <span className="ov-controls-label">Ъгъл на гледане</span>
          <div className="ovz-seg ov-switch">
            {angles.map((a) => (
              <Link
                key={a.key}
                to={hrefWith({ angle: a.key === 'time' ? null : a.key })}
                preventScrollReset
                aria-current={angle === a.key || undefined}
              >
                {a.label}
              </Link>
            ))}
          </div>
          <div className="ov-chips">
            {chips.length ? (
              <>
                <span className="ov-controls-label">Филтри</span>
                {chips.map((c) => (
                  <Link
                    key={c.label}
                    to={hrefWith(c.clear)}
                    preventScrollReset
                    className="ov-chip"
                    aria-label={`Премахни филтъра ${c.label}`}
                  >
                    {c.label} <span aria-hidden="true">✕</span>
                  </Link>
                ))}
              </>
            ) : (
              <span className="ov-hint">{lensHint}</span>
            )}
          </div>
        </nav>

        {/* Announce server-rendered chart/list updates when a CPV code or year is (de)selected. */}
        <p className="sr-only" role="status">
          {navigating
            ? 'Обновяване на данните…'
            : cpvSel.length
              ? `Графиката и списъкът показват ${count(cpvSel.length)} ${plural(cpvSel.length, 'избрана CPV група', 'избрани CPV групи')}.`
              : 'Графиката и списъкът показват всички CPV групи.'}
        </p>

        {angle === 'time' && (
          <section className="ovz-panel" aria-label="Разходи във времето">
            <div className="ov-panel-head">
              <h2 className="ovz-panel-title">
                Разходи във <em>времето</em>
              </h2>
              <div className="ov-panel-tools">
                <span className="ovz-legend" aria-hidden="true">
                  <span className="ov-legend-bar" /> договори
                  <span className="ov-legend-line" /> € обем
                </span>
                <div className="ovz-seg" role="group" aria-label="Стъпка на графиката">
                  {steps.map((s) => (
                    <Link
                      key={s.key}
                      to={hrefWith({ step: s.key === 'q' ? null : s.key })}
                      preventScrollReset
                      aria-current={step === s.key || undefined}
                    >
                      {s.label}
                    </Link>
                  ))}
                </div>
              </div>
            </div>
            {trend.points.length >= 2 ? (
              <ComboTrendChart points={trend.points} granularity={trend.granularity} />
            ) : (
              <p className="muted">Няма достатъчно данни.</p>
            )}
            <div className="ov-years">
              {yearCards.map((y) => (
                <Link
                  key={y.year}
                  to={y.href}
                  preventScrollReset
                  className={`ov-year${y.active ? ' is-active' : ''}`}
                  aria-current={y.active || undefined}
                >
                  <span className="ov-year-label mono">
                    {y.year}
                    {y.partial && <span className="ov-year-partial"> частично</span>}
                  </span>
                  <span className="ov-year-val mono">{money(y.valueEur)}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {angle === 'cpv' && cpvPanel(false)}

        {angle === 'cross' && (
          <div className="ov-cross">
            <section className="ovz-panel ov-cross-year" aria-label="Избор на година">
              <h2 className="ovz-panel-title">
                Избери <em>година</em>
              </h2>
              <p className="ov-panel-hint">
                После стеснѝ по CPV код от съседния списък — графиката се преизчислява само върху
                избраните групи.
              </p>
              {trend.points.length < 2 && (
                <p className="muted ov-cross-chart-empty">
                  Няма достатъчно данни за избраните CPV групи.
                </p>
              )}
              {trend.points.length >= 2 && (
                <ComboTrendChart
                  points={trend.points}
                  granularity={trend.granularity}
                  cssHeight={260}
                  interactive={false}
                  ariaLabel={
                    cpvSel.length
                      ? `Брой договори и € обем във времето само за избраните CPV групи: ${cpvSel.join(', ')}`
                      : 'Брой договори и € обем във времето за всички CPV групи'
                  }
                />
              )}
              <div className="ov-years">
                {yearCards.map((y) => (
                  <Link
                    key={y.year}
                    to={y.href}
                    preventScrollReset
                    className={`ov-year is-slim${y.active ? ' is-active' : ''}`}
                    aria-current={y.active || undefined}
                  >
                    <span className="ov-year-label mono">{y.year}</span>
                  </Link>
                ))}
              </div>
            </section>
            {cpvPanel(true)}
          </div>
        )}

        <section className="ovz-panel ov-list" aria-label="Договори за избора">
          <div className="ov-panel-head">
            <div>
              <h2 className="ovz-panel-title">
                {sort === 'value' ? 'Договори · по стойност' : 'Договори · най-нови'}
              </h2>
              <p className="ov-panel-hint">
                {count(contracts.length)} {plural(contracts.length, 'договор', 'договора')}
                {contracts.length === 24 ? ' (показани първите 24)' : ''} · {scopeText}
              </p>
            </div>
            <div className="ov-panel-tools">
              <span className="ov-controls-label">Подредба</span>
              <div className="ovz-seg" role="group" aria-label="Подредба на договорите">
                {sorts.map((s) => (
                  <Link
                    key={s.key}
                    to={hrefWith({ sort: s.key === 'date' ? null : s.key })}
                    preventScrollReset
                    aria-current={sort === s.key || undefined}
                  >
                    {s.label}
                  </Link>
                ))}
              </div>
            </div>
          </div>
          {contracts.length ? (
            <ul className="ov-cards">
              {contracts.map((c) => {
                const cohort = c.cpvGroup ? cohorts.get(c.cpvGroup) : undefined;
                const rel = cohort ? relLabel(c.valueEur, cohort.medianEur) : null;
                return (
                  <li key={c.id}>
                    <Link to={`/contracts/${c.id}`} className="ov-card">
                      <span className="ov-card-top">
                        <span className="ov-card-date mono">{fmtDate(c.signedAt)}</span>
                        <span className="ov-card-val mono">{money(c.valueEur)}</span>
                      </span>
                      <span className="ov-card-buyer clamp">{c.authorityName}</span>
                      <span className="ov-card-seller clamp">
                        <span aria-hidden="true">→ </span>
                        {c.bidderName}
                      </span>
                      <span className="ov-card-foot">
                        {c.cpvGroup && <span className="ov-card-cpv mono">CPV {c.cpvGroup}</span>}
                        <span className="ov-card-cohort clamp">{cohort?.name ?? ''}</span>
                        {rel && <span className={`ov-card-rel mono ${rel.cls}`}>{rel.text}</span>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="ov-empty">Няма договори за този избор.</p>
          )}
          <p className="ov-note">
            „Спрямо типичното" сравнява стойността на договора с медианата за неговия CPV код.
            Данните нямат количества, затова по-високата стойност често значи просто по-голям обем —
            това е ориентир за разглеждане, не оценка.
          </p>
        </section>

        <Callout title="За покритието на данните">
          <p style={{ margin: 0 }}>
            Изгледът включва договорите с валидна дата на сключване и стойност в евро. Последният
            период е непълен и е отбелязан като „частично". Виж методологията за подробности.
          </p>
        </Callout>
      </main>
    </>
  );
}
