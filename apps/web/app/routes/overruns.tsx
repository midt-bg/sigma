import { type ReactNode, useState } from 'react';
import { Link, useNavigation, useSearchParams } from 'react-router';
import { count, date, money, moneyBare, pct, signedPct } from '@sigma/shared';
import {
  getOverrunAnnexes,
  getOverrunsAnalytics,
  type OverrunAuthorityRow,
  type OverrunRow,
  type OverrunSectorRow,
} from '@sigma/db';
import type { Route } from './+types/overruns';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { DataTable, type Column } from '../components/DataTable';
import { FullscreenButton, useFullscreen } from '../components/FullscreenButton';
import { MetricInfo } from '../components/MetricInfo';
import { Callout, ShareBar } from '../components/ui';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';
import {
  formatGrowthFactor,
  overrunBarGeometry,
  scatterGeometry,
  type ScatterDatum,
} from '../lib/overruns-chart';
import {
  contractStatus,
  groupAnnexes,
  STATUS_LABEL,
  type AnnexEntry,
} from '../lib/overruns-inspector';
import { withParams } from '../lib/filters';

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({
    matches,
    path: '/overruns',
    title: 'Раздуване — СИГМА',
    description:
      'Кои договори се раздуха най-много след подписването чрез анекси. Класация по абсолютно и процентно нарастване, облак на раздуването, по сектори (CPV) и по институции — всеки лев проследим до конкретния договор.',
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const by = new URL(request.url).searchParams.get('by') === 'percent' ? 'percent' : 'absolute';
  const { env } = context.cloudflare;
  return withDbRetry(async () => {
    // Five bounded queries (see getOverrunsAnalytics): leaderboard, corpus aggregate, median, by-
    // authority, by-sector. Then ONE more bounded query for the shown contracts' annex history — the
    // inspector is client-selected, so everything it needs is fetched here and rendered from memory.
    const data = await getOverrunsAnalytics(env.DB, { by });
    const annexes = await getOverrunAnnexes(
      env.DB,
      data.rows.map((r) => r.contractId),
    );
    return { data, by, annexesByContract: groupAnnexes(annexes) };
  });
}

// ── design tokens (mock hexes → app CSS variables) ───────────────────────────────────
// Static layout/typography styles live in app.css (block „overruns-dashboard"). These constants are
// kept ONLY for the SVG scatter's presentation attributes (fill/stroke) — the few places where a value
// is data-driven and cannot be a static class.
const INK = 'var(--ink)';
const INK_SOFT = 'var(--ink-soft)';
const ACCENT = 'var(--accent)';
const RULE = 'var(--rule)';
const RULE_SOFT = 'var(--rule-soft)';
const PAPER = 'var(--paper)';

// ── leaderboard table (the accessible figures, every row linked) ──────────────────────
const contractColumns: Column<OverrunRow>[] = [
  { key: 'rank', header: '#', isRank: true, cell: (_r, i) => i + 1 },
  {
    key: 'subject',
    header: 'Договор',
    isTitle: true,
    cell: (r) => <Link to={`/contracts/${r.contractSlug}`}>{r.subject}</Link>,
  },
  {
    key: 'parties',
    header: 'Възложител · Изпълнител',
    secondary: true,
    cell: (r) => (
      <>
        <Link to={`/authorities/${r.authoritySlug}`}>{r.authorityName}</Link>
        {' → '}
        <Link to={`/companies/${r.bidderSlug}`}>{r.bidderName}</Link>
      </>
    ),
  },
  { key: 'signing', header: 'При сключване', align: 'money', cell: (r) => money(r.signingEur) },
  { key: 'current', header: 'Сега', align: 'money', cell: (r) => money(r.currentEur) },
  {
    key: 'delta',
    header: 'Нарастване',
    align: 'money',
    cell: (r) => (
      <>
        +{money(r.deltaEur)} <span className="muted">({signedPct(r.pct)})</span>
      </>
    ),
  },
  {
    key: 'annex',
    header: 'Анекси',
    align: 'num',
    secondary: true,
    cell: (r) => count(r.annexCount),
  },
];

// ── inspector field helpers (REAL contract metadata, mock-faithful formatting) ────────
// „Финансиране": EU-funded → „Европейско [· programme]", national → „Национално", unknown → „—".
function financingText(row: OverrunRow): string {
  if (row.euFunded == null) return '—';
  if (!row.euFunded) return 'Национално';
  return row.euProgramme ? `Европейско · ${row.euProgramme}` : 'Европейско';
}

// „CPV код": „45233110 — Строеж на магистрали" when both present; code alone, or „—" when absent.
function cpvText(row: OverrunRow): string {
  if (!row.cpvCode) return '—';
  return row.cpvDescription ? `${row.cpvCode} — ${row.cpvDescription}` : row.cpvCode;
}

// „Срок": the contract term — the tender's „Очакван край" date when present, else the contract's
// duration in days. Returns null when neither is on record so the row is omitted (never fabricated).
function termText(row: OverrunRow): string | null {
  if (row.endDate) return date(row.endDate);
  if (row.durationDays != null) return `${count(row.durationDays)} дни`;
  return null;
}

// The structured „ДЕТАЙЛИ ПО ДОГОВОРА" grid — every value is a real contracts/tenders column. The
// „Срок" row is only included when a real term value exists.
function inspectorFields(row: OverrunRow): { k: string; v: string }[] {
  const term = termText(row);
  return [
    { k: 'Сектор', v: row.sectorLabel },
    { k: 'Процедура', v: row.procedureType ?? '—' },
    { k: 'CPV код', v: cpvText(row) },
    { k: 'Финансиране', v: financingText(row) },
    { k: 'Сключен', v: date(row.signedAt) },
    ...(term ? [{ k: 'Срок', v: term }] : []),
    { k: 'Възложител · ЕИК', v: `${row.authorityName} · ${row.authorityEik || '—'}` },
    { k: 'Изпълнител · ЕИК', v: `${row.bidderName} · ${row.bidderEik || 'непотвърден'}` },
  ];
}

// ── section header (serif title + mono note, the design's per-section caption row) ────
function SectionHead({ id, title, note }: { id: string; title: ReactNode; note?: string }) {
  return (
    <div className="ov-sec-head">
      <h2 id={id} className="ov-sec-title">
        {title}
      </h2>
      {note ? <span className="ov-sec-note">{note}</span> : null}
    </div>
  );
}

// ── before→now stacked bar (decorative; the figures sit beside it as text) ────────────
// Only the geometry (segment widths, overall length) is inline — it is data-driven. Colours and the
// dashed track live in app.css.
function OverrunBar({
  signingEur,
  currentEur,
  scaleMaxEur,
}: {
  signingEur: number;
  currentEur: number;
  scaleMaxEur: number;
}) {
  const g = overrunBarGeometry(signingEur, currentEur, scaleMaxEur);
  return (
    <div className="ov-bar" aria-hidden="true">
      <div className="ov-bar-track" />
      <div className="ov-bar-fill" style={{ width: `${Math.max(g.nowScalePct, 0.8)}%` }}>
        <div className="ov-bar-sign" style={{ width: `${g.signPct}%` }} />
        <div className="ov-bar-inc" style={{ width: `${g.incPct}%` }} />
      </div>
    </div>
  );
}

// ── the „Облак на раздуването" scatter (visual summary; role=img + the list carries the data) ──
function OverrunScatter({
  rows,
  selected,
  onSelect,
}: {
  rows: OverrunRow[];
  selected: number;
  onSelect: (index: number) => void;
}) {
  const data: ScatterDatum[] = rows.map((r, i) => ({
    id: r.contractId,
    pct: r.pct,
    deltaEur: r.deltaEur,
    annexCount: r.annexCount,
    rank: i + 1,
  }));
  const geo = scatterGeometry(data);
  const { axis } = geo;
  const selectedId = rows[selected]?.contractId;
  // Bulgarian decimal comma for the „к%" (thousands) tick labels — e.g. +2,5к%, +10к%.
  const xtickLabel = (pctPercent: number) =>
    pctPercent >= 1000
      ? `+${(Math.round(pctPercent / 100) / 10).toString().replace('.', ',')}к%`
      : `+${pctPercent}%`;

  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${geo.width} ${geo.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Облак на раздуването: всеки договор по процентно нарастване (хоризонтално) спрямо раздуване в евро (вертикално); размерът на кръга расте с броя анекси. Конкретните стойности са в класацията вляво."
      className="ov-scatter-svg"
    >
      <line
        x1={axis.left}
        y1={axis.top}
        x2={axis.left}
        y2={axis.bottom}
        stroke={RULE}
        strokeWidth={1}
      />
      <line
        x1={axis.left}
        y1={axis.bottom}
        x2={axis.right}
        y2={axis.bottom}
        stroke={RULE}
        strokeWidth={1}
      />
      {geo.grid.map((g) => (
        <g key={`g${g.y}`}>
          <line
            x1={axis.left}
            y1={g.y}
            x2={axis.right}
            y2={g.y}
            stroke={RULE_SOFT}
            strokeWidth={1}
          />
          <text
            x={axis.left - 5}
            y={g.y + 3}
            textAnchor="end"
            fontFamily="var(--font-mono)"
            fontSize={8.5}
            fill={INK_SOFT}
          >
            {moneyBare(g.value)}
          </text>
        </g>
      ))}
      {geo.xticks.map((t) => (
        <text
          key={`x${t.pctPercent}`}
          x={t.x}
          y={geo.height - 24}
          textAnchor="middle"
          fontFamily="var(--font-mono)"
          fontSize={8.5}
          fill={INK_SOFT}
        >
          {xtickLabel(t.pctPercent)}
        </text>
      ))}
      <text x={6} y={14} fontFamily="var(--font-mono)" fontSize={8.5} fill={INK_SOFT}>
        € раздуване
      </text>
      <text
        x={axis.right}
        y={geo.height - 2}
        textAnchor="end"
        fontFamily="var(--font-mono)"
        fontSize={8.5}
        fill={INK_SOFT}
      >
        % нарастване →
      </text>
      {geo.points.map((p) => {
        const isSel = p.id === selectedId;
        return (
          <g key={p.id}>
            {isSel && (
              <circle cx={p.x} cy={p.y} r={p.r + 4} fill="none" stroke={ACCENT} strokeWidth={1.5} />
            )}
            <circle
              className="ov-scatter-dot"
              cx={p.x}
              cy={p.y}
              r={isSel ? p.r * 1.18 : p.r}
              fill={isSel || p.big ? ACCENT : INK}
              fillOpacity={isSel ? 1 : p.big ? 0.78 : 0.5}
              stroke={PAPER}
              strokeWidth={1}
              style={{ cursor: 'pointer' }}
              onClick={() => onSelect(p.rank - 1)}
            >
              <title>{`#${p.rank} · ${rows[p.rank - 1]?.subject ?? ''}`}</title>
            </circle>
            {(p.big || isSel) && (
              <text
                x={p.x + p.r + 3}
                y={p.y + 3}
                fontFamily="var(--font-mono)"
                fontSize={8.5}
                fontWeight={600}
                fill={isSel ? ACCENT : INK}
              >
                #{p.rank}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── annex history block (REAL amendment rows for the selected contract) ───────────────
function AnnexHistory({ annexes, contractSlug }: { annexes: AnnexEntry[]; contractSlug: string }) {
  return (
    <div className="ov-annex-wrap">
      <div className="ov-mono-label ov-annex-heading">
        История на анексите <span className="ov-accent">· {count(annexes.length)}</span>
      </div>
      {annexes.length ? (
        <ol className="ov-annex-list">
          {annexes.map((a) => (
            <li className="ov-annex-row" key={a.seq}>
              <div className="ov-annex-main">
                <span className="ov-annex-seq">Анекс {a.seq}</span>
                <span className="ov-annex-date">{date(a.date)}</span>
                <span className="ov-annex-delta">
                  {/* money() already emits a minus for negatives; only prefix „+" for an increase so a
                      reducing amendment reads „−100 €", not „+−100 €". */}
                  {a.deltaEur != null ? `${a.deltaEur > 0 ? '+' : ''}${money(a.deltaEur)}` : '—'}
                </span>
              </div>
              {a.reason ? <div className="ov-annex-reason">{a.reason}</div> : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="ov-annex-empty">
          Подробната разбивка на анексите не е налична за този договор в обхванатите данни.
        </p>
      )}
      <p className="ov-insp-source">
        Източник ·{' '}
        <Link to={`/contracts/${contractSlug}`}>Регистър на обществените поръчки (АОП) →</Link>
      </p>
    </div>
  );
}

// ── SECTION 1 + 2 — ranked bars (full width) ↔ scatter cloud + inspector ──────────────
// One component so the bar list, the scatter and the inspector share the client-selected row.
function OverrunsDashboard({
  rows,
  annexesByContract,
}: {
  rows: OverrunRow[];
  annexesByContract: Record<string, AnnexEntry[]>;
}) {
  const [selected, setSelected] = useState(0);
  const scaleMax = Math.max(1, ...rows.map((r) => r.currentEur));
  const sel = rows[selected] ?? rows[0]!;
  const status = contractStatus(sel.endDate);
  const selAnnexes = annexesByContract[sel.contractId] ?? [];
  const boardFs = useFullscreen<HTMLDivElement>();
  const scatterFs = useFullscreen<HTMLDivElement>();

  return (
    <>
      {/* SECTION — ranked bars (full width) */}
      <section className="ov-section" aria-labelledby="ov-board-h">
        <SectionHead
          id="ov-board-h"
          title={
            <>
              Най-голямо <em>раздуване</em> на стойността
            </>
          }
          note={`скала 0 — ${moneyBare(scaleMax)} · кликни ред за детайли`}
        />
        <div className="ov-panel ov-board" ref={boardFs.ref}>
          <div className="ov-board-head">
            <div className="ov-board-title">
              Договори по <em>мащаб</em>
            </div>
            <div className="ov-board-scale">
              <span>скала 0 — {moneyBare(scaleMax)}</span>
              <FullscreenButton active={boardFs.isFullscreen} onToggle={boardFs.toggle} />
            </div>
          </div>
          <ol className="scrolly ov-board-list">
            {rows.map((r, i) => {
              const active = i === selected;
              return (
                <li key={r.contractId}>
                  <button
                    type="button"
                    onClick={() => setSelected(i)}
                    aria-pressed={active}
                    className="ov-row"
                  >
                    <span className="ov-row-rank">{i + 1}</span>
                    <span className="ov-row-body">
                      <span className="ov-row-head">
                        <span className="clamp1 ov-row-subject">{r.subject}</span>
                        <span className="ov-row-value">
                          {money(r.currentEur)}{' '}
                          <span className={i === 0 ? 'ov-row-pct is-top' : 'ov-row-pct'}>
                            {signedPct(r.pct)}
                          </span>
                        </span>
                      </span>
                      <OverrunBar
                        signingEur={r.signingEur}
                        currentEur={r.currentEur}
                        scaleMaxEur={scaleMax}
                      />
                      <span className="clamp1 ov-row-meta">
                        {r.authorityName} <span className="ov-arrow">→</span> {r.bidderName} · от{' '}
                        {money(r.signingEur)} · {count(r.annexCount)} анекса
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      {/* SECTION — scatter cloud + inspector (side by side) */}
      <section className="ov-section" aria-labelledby="ov-cloud-h">
        <SectionHead
          id="ov-cloud-h"
          title={
            <>
              Облак на <em>раздуването</em>
            </>
          }
          note="хоризонтално % растеж · вертикално € раздуване · размер = брой анекси · кликни точка за детайли"
        />
        <div className="ov-figure-grid">
          <div className="ov-panel ov-scatter-panel" ref={scatterFs.ref}>
            <div className="ov-scatter-head">
              <div className="ov-panel-title">Облак на раздуването</div>
              <div className="ov-panel-note">
                <span>размер = брой анекси</span>
                <FullscreenButton active={scatterFs.isFullscreen} onToggle={scatterFs.toggle} />
              </div>
            </div>
            <div className="ov-scatter-body">
              <OverrunScatter rows={rows} selected={selected} onSelect={setSelected} />
            </div>
          </div>

          {/* inspector */}
          <div className="ov-panel ov-inspector">
            <div className="ov-insp-head">
              <div className="ov-insp-head-top">
                <div className="ov-mono-label ov-accent">Избран договор · #{selected + 1}</div>
                {status ? (
                  <span className={`ov-status-badge ${status}`}>{STATUS_LABEL[status]}</span>
                ) : null}
              </div>
              <div className="ov-insp-title">
                <Link to={`/contracts/${sel.contractSlug}`}>{sel.subject}</Link>
              </div>
              <div className="ov-insp-parties">
                <Link to={`/authorities/${sel.authoritySlug}`}>{sel.authorityName}</Link>{' '}
                <span className="ov-accent">→</span>{' '}
                <Link to={`/companies/${sel.bidderSlug}`}>{sel.bidderName}</Link>
              </div>
              <div className="ov-insp-figures">
                <div>
                  <div className="ov-insp-fig-label">При сключване</div>
                  <div className="ov-insp-fig-val">{money(sel.signingEur)}</div>
                </div>
                <div className="ov-insp-arrow">→</div>
                <div>
                  <div className="ov-insp-fig-label">Сега</div>
                  <div className="ov-insp-fig-val now">{money(sel.currentEur)}</div>
                </div>
                <div className="ov-insp-delta-wrap">
                  <div className="ov-insp-delta">+{money(sel.deltaEur)}</div>
                  <div className="ov-insp-delta-meta">
                    {signedPct(sel.pct)} · {count(sel.annexCount)} анекса
                  </div>
                </div>
              </div>
            </div>
            <div className="ov-insp-grid-wrap">
              <div className="ov-mono-label ov-insp-grid-heading">Детайли по договора</div>
              <dl className="ov-insp-grid">
                {inspectorFields(sel).map((f) => (
                  <div className="ov-insp-grid-row" key={f.k}>
                    <dt className="ov-insp-grid-key">{f.k}</dt>
                    <dd className="ov-insp-grid-val">{f.v}</dd>
                  </div>
                ))}
              </dl>
              <AnnexHistory annexes={selAnnexes} contractSlug={sel.contractSlug} />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

// ── SECTION 3 — overrun-by-sector table (CPV division, aggregate growth, € at risk) ───────────
const BUCKET_LABEL: Record<OverrunSectorRow['bucket'], string> = {
  works: 'строителство',
  goods: 'доставки',
  services: 'услуги',
  other: 'друго',
};

function SectorSection({ rows }: { rows: OverrunSectorRow[] }) {
  // Reserve the accent for the single largest grower; the rest stay neutral so it actually stands out.
  const topGrowthCode = rows.reduce<{ code: string; growth: number }>(
    (best, s) => (s.growth > best.growth ? { code: s.code, growth: s.growth } : best),
    { code: '', growth: -Infinity },
  ).code;
  const hasOther = rows.some((s) => s.bucket === 'other');
  const legendBuckets = (
    hasOther ? ['works', 'goods', 'services', 'other'] : ['works', 'goods', 'services']
  ) as OverrunSectorRow['bucket'][];
  return (
    <section className="ov-section" aria-labelledby="ov-sector-h">
      <SectionHead
        id="ov-sector-h"
        title={
          <>
            Раздуване по <em>сектори</em>
          </>
        }
        note="общ растеж и сума под риск по сектор (CPV)"
      />
      <div className="ov-panel ov-sector-list-panel">
        <ul className="ov-bucket-legend" aria-label="Легенда на секторите">
          {legendBuckets.map((b) => (
            <li key={b} className="ov-bucket-legend-item">
              <span aria-hidden="true" className={`ov-sector-dot ${b}`} />
              {BUCKET_LABEL[b]}
            </li>
          ))}
        </ul>
        <table className="ov-sector-table">
          <caption className="sr-only">
            Раздуване по сектори (CPV): код, сектор, общ растеж (сума раздуване / сума при
            сключване) и обща сума под риск.
          </caption>
          <thead>
            <tr>
              <th>
                CPV
                <MetricInfo
                  title="CPV"
                  summary="Двуцифреният CPV раздел на поръчката — първите две цифри от CPV кода определят сектора."
                />
              </th>
              <th>
                Сектор
                <MetricInfo
                  title="Сектор"
                  summary="Името на CPV раздела; точката отбелязва типа — строителство, доставки или услуги."
                />
              </th>
              <th>
                Растеж
                <MetricInfo
                  align="end"
                  title="Растеж"
                  summary="Общият растеж на сектора: сборът на раздуванията, разделен на сбора на подписаните стойности на раздутите му договори."
                  readout="Претеглен по €, не средно на процентите — малките договори не изкривяват."
                />
              </th>
              <th>
                € риск
                <MetricInfo
                  align="end"
                  title="€ риск"
                  summary="Сумата под риск: сборът на (текуща − подписана стойност) по раздутите договори в сектора."
                  readout="Само договори с анекс, текуща > подписана и подписана стойност ≥ 1000 €."
                />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.code}>
                <td className="ov-sector-code">{s.code || '—'}</td>
                <td className="ov-sector-name">
                  <span
                    aria-hidden="true"
                    className={`ov-sector-dot ${s.bucket}`}
                    title={BUCKET_LABEL[s.bucket]}
                  />
                  <span className="clamp1">{s.label}</span>
                </td>
                <td
                  className={
                    s.code === topGrowthCode && rows.length > 1
                      ? 'ov-sector-growth is-top'
                      : 'ov-sector-growth'
                  }
                >
                  {signedPct(s.growth)}
                </td>
                <td className="ov-sector-risk">{moneyBare(s.riskEur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── SECTION 4 — institutions table (total overrun, count, share of max, aggregate growth) ──
function AuthoritySection({ rows }: { rows: OverrunAuthorityRow[] }) {
  const maxTotal = Math.max(1, ...rows.map((r) => r.totalOverrunEur));
  return (
    <section className="ov-section" aria-labelledby="ov-auth-h">
      <SectionHead
        id="ov-auth-h"
        title={
          <>
            Кои <em>институции</em> раздуват най-много
          </>
        }
        note="подредени по обща сума на раздуването"
      />
      <div className="ov-panel ov-auth-panel">
        <div className="ov-table-scroll">
          <table className="ov-auth-table">
            <caption className="sr-only">
              Възложители, подредени по обща сума на раздуването: брой договори, дял от най-големия
              възложител и общ растеж (сума раздуване / сума при сключване).
            </caption>
            <thead>
              <tr>
                <th className="c-rank">№</th>
                <th className="c-name">Възложител</th>
                <th className="c-num">
                  Раздуване
                  <MetricInfo
                    align="end"
                    title="Раздуване"
                    summary="Общото раздуване на възложителя в евро: сборът на (текуща − подписана стойност) по всичките му раздути договори."
                    readout="Само договори с анекс, текуща > подписана и подписана стойност ≥ 1000 €."
                  />
                </th>
                <th className="c-num">
                  Договори
                  <MetricInfo
                    align="end"
                    title="Договори"
                    summary="Броят раздути договори на възложителя — с поне един анекс и текуща стойност над подписаната (подписана ≥ 1000 €)."
                  />
                </th>
                <th className="c-share">
                  Дял от макс
                  <MetricInfo
                    align="end"
                    title="Дял от макс"
                    summary="Раздуването на реда като дял от най-голямото раздуване в таблицата (първия ред) — визуално сравнение, не дял от общото."
                  />
                </th>
                <th className="c-num">
                  Растеж
                  <MetricInfo
                    align="end"
                    title="Растеж"
                    summary="Общият растеж на портфейла: сборът на раздуванията, разделен на сбора на подписаните стойности на раздутите договори."
                    readout="Претеглен по €, не средно на процентите — малките договори не изкривяват."
                  />
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.authoritySlug}>
                  <td className="c-rank">{i + 1}</td>
                  <td className="c-name">
                    <Link to={`/authorities/${r.authoritySlug}`}>{r.authorityName}</Link>
                  </td>
                  <td className="c-num ov-auth-total">{moneyBare(r.totalOverrunEur)}</td>
                  <td className="c-num">{count(r.count)}</td>
                  <td className="c-share">
                    <ShareBar ratio={r.totalOverrunEur / maxTotal} />
                  </td>
                  <td className={i === 0 ? 'c-num ov-auth-growth is-top' : 'c-num ov-auth-growth'}>
                    {signedPct(r.growth)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="ov-auth-foot">
          — агрегирано от {count(rows.length)} възложителя · данни АОП —
        </p>
      </div>
    </section>
  );
}

export default function Overruns({ loaderData }: Route.ComponentProps) {
  const { data, by } = loaderData;
  const { corpus, rows, byAuthority, bySector } = data;
  const annexesByContract = loaderData.annexesByContract;
  const [sp] = useSearchParams();
  const navigating = useNavigation().state !== 'idle';

  const sortHref = (next: 'absolute' | 'percent') =>
    `/overruns${withParams(sp, { by: next === 'percent' ? 'percent' : null })}`;

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Раздуване' }]} />
      <main id="main" className="ov-page">
        {/* masthead: kicker + title + lede on the left, the three headline KPIs inline on the right */}
        <header className="ov-mast">
          <div className="ov-mast-main">
            <p className="ov-mast-kicker">— Анализ · Раздуване</p>
            <h1 className="ov-mast-title">
              Раздуване на <em>договорите</em>
            </h1>
            <p className="ov-mast-lede">
              Договори, чиято стойност след анекси (допълнителни споразумения след подписването)
              надхвърля стойността при сключване. Списъкът подрежда по мащаб, облакът показва къде
              стои всеки договор, а таблицата — кои институции раздуват най-много.
            </p>
          </div>
          <dl className="ov-mast-kpis" aria-label="Обобщение на раздуването">
            <div className="ov-hk">
              <dd className="ov-hk-v">{money(corpus.totalOverrunEur)}</dd>
              <dt className="ov-hk-l">
                ОБЩО РАЗДУВАНЕ
                <MetricInfo
                  title="Общо раздуване"
                  summary="Сумата, с която стойността на договорите е нараснала над стойността при сключване — чрез анекси."
                  readout={
                    corpus.shareOfSigning > 0
                      ? `≈ ${pct(corpus.shareOfSigning)} от общо подписаната стойност на корпуса.`
                      : undefined
                  }
                />
              </dt>
            </div>
            <div className="ov-hk">
              <dd className="ov-hk-v">{count(corpus.count)}</dd>
              <dt className="ov-hk-l">
                ДОГОВОРА
                <MetricInfo
                  title="Договора"
                  summary="Броят договори с поне един анекс, увеличил потвърдено стойността след сключване (под €1000 подписана стойност се изключват)."
                />
              </dt>
            </div>
            <div className="ov-hk">
              <dd className="ov-hk-v accent">
                {corpus.count ? formatGrowthFactor(corpus.medianPct) : '—'}
              </dd>
              <dt className="ov-hk-l">
                ТИПИЧЕН РАСТЕЖ
                <MetricInfo
                  align="end"
                  title="Типичен растеж"
                  summary="Типичното нарастване: половината договори растат повече, половината по-малко — една шепа екстремни случаи не може да го изкриви."
                  readout={
                    corpus.count
                      ? `Средното е ${signedPct(corpus.avgPct)} — изкривено нагоре от малкото огромни раздувания.`
                      : undefined
                  }
                />
              </dt>
            </div>
          </dl>
        </header>

        {/* sticky filter bar: „ПОДРЕДИ ПО" segmented toggle (drives ?by=) + the before→now legend */}
        <div className="ov-filterbar" role="group" aria-label="Подреждане на класацията">
          <span className="ov-filterbar-label">Подреди по</span>
          <div className="ov-seg">
            <Link
              to={sortHref('absolute')}
              aria-current={by === 'absolute' ? 'true' : undefined}
              rel="nofollow"
            >
              абсолютно €
            </Link>
            <Link
              to={sortHref('percent')}
              aria-current={by === 'percent' ? 'true' : undefined}
              rel="nofollow"
            >
              процентно %
            </Link>
          </div>
          <span className="ov-legend">
            <span className="ov-legend-item">
              <span aria-hidden="true" className="ov-swatch ink" />
              при сключване
            </span>
            <span className="ov-legend-item">
              <span aria-hidden="true" className="ov-swatch accent" />
              раздуване
            </span>
          </span>
        </div>

        <p className="sr-only" role="status">
          {navigating ? 'Обновяване на класацията…' : 'Класацията е обновена.'}
        </p>

        {byAuthority.length ? (
          <AuthoritySection rows={byAuthority} />
        ) : (
          <section className="ov-section" aria-labelledby="ov-auth-empty-h">
            <SectionHead
              id="ov-auth-empty-h"
              title={
                <>
                  Кои <em>институции</em> раздуват най-много
                </>
              }
            />
            <Callout title="Няма данни по институции">
              <p className="m-0">Все още няма институции с раздути договори в обхванатите данни.</p>
            </Callout>
          </section>
        )}

        {bySector.length ? (
          <SectorSection rows={bySector} />
        ) : (
          <section className="ov-section" aria-labelledby="ov-sector-empty-h">
            <SectionHead
              id="ov-sector-empty-h"
              title={
                <>
                  Раздуване по <em>сектори</em>
                </>
              }
            />
            <Callout title="Няма данни по сектори">
              <p className="m-0">Все още няма сектори с раздути договори в обхванатите данни.</p>
            </Callout>
          </section>
        )}

        {rows.length ? (
          <>
            <OverrunsDashboard key={by} rows={rows} annexesByContract={annexesByContract} />
            <details className="ov-table-details">
              <summary className="ov-table-summary">
                Виж класацията като таблица ({count(rows.length)} договора)
              </summary>
              <div className="ov-table-body">
                <DataTable
                  columns={contractColumns}
                  rows={rows}
                  getKey={(r) => r.contractId}
                  caption="Договори, подредени по нарастване на стойността след подписване"
                />
              </div>
            </details>
          </>
        ) : (
          <Callout title="Няма раздути договори">
            <p className="m-0">
              В обхванатите данни няма договори с потвърдено нарастване на стойността след
              подписване. Щом анекс увеличи стойност, договорът ще се появи тук.
            </p>
          </Callout>
        )}

        <p className="small muted ov-methodology">
          Раздуването е разликата между сегашната стойност и стойността при сключване, само за
          договори с поне един анекс и потвърдени стойности. Растежът на сектор/институция е спрямо
          общата сума (сума раздуване / сума при сключване), а не средно на процентите. Нарастването
          не означава непременно нередност — увеличения по анекси може да са напълно законни
          (индексация на цени, разширен обхват, непредвидени дейности). Виж{' '}
          <Link to="/methodology#glossary">методологията</Link> за дефинициите.
        </p>
      </main>
    </>
  );
}
