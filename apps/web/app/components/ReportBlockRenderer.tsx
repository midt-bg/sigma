// Renders a ResolvedBlock[] from a StoredReport into UI (spec §D4 / §D5 dependencies).
//
// Block-to-component mapping:
//   text      → MarkdownBlock (D3: no raw HTML, http/https links only)
//   callout   → callout section + MarkdownBlock
//   totals    → TotalsStrip (existing)
//   facts     → FactsList (existing)
//   table     → DataTable (existing) — entity links built via entityHref
//   bar       → CSS proportional bar list (inline, no chart lib)
//   flows     → summary table (edges from/to/value)
//   timeseries → TimeseriesBlock (D1: hand-built SVG)

import { Link } from 'react-router';
import { money } from '@sigma/shared';
import type { ResolvedBlock, CellFormat } from '~/lib/assistant-contract/report';
import { formatCell, entityHref } from '~/lib/assistant/render-format';
import { TotalsStrip } from '~/components/TotalsStrip';
import { FactsList } from '~/components/FactsList';
import { DataTable } from '~/components/DataTable';
import { MarkdownBlock } from '~/components/MarkdownBlock';
import { TimeseriesBlock } from '~/components/TimeseriesBlock';
import { WeeklyGhostBars } from '~/components/WeeklyGhostBars';

// ── Callout ──────────────────────────────────────────────────────────────────

function CalloutBlock({ title, md }: { title: string; md: string }) {
  return (
    <aside className="report-block report-block--callout">
      <strong className="report-block__callout-title">{title}</strong>
      <MarkdownBlock md={md} className="report-block__callout-body" />
    </aside>
  );
}

// ── Bar ──────────────────────────────────────────────────────────────────────

function BarBlock({
  points,
  truncated,
  format,
}: {
  points: { label: string | number | null; value: number }[];
  truncated?: boolean;
  format?: CellFormat;
}) {
  if (points.length === 0) return <p className="chart-empty">Няма данни</p>;
  const max = Math.max(1, ...points.map((p) => p.value));
  const rows = points.map((p) => ({
    label: p.label == null || p.label === '' ? '—' : String(p.label),
    value: formatCell(p.value, format ?? 'money'),
    pct: ((p.value / max) * 100).toFixed(1),
  }));
  return (
    <div className="report-block report-block--bar">
      {/* Visually-hidden data table — the AT-accessible source (WCAG 1.1.1).
          The bar list is aria-hidden; screen readers and text-only mode use this table instead.
          AccessibilityWidget's SURVIVAL_CSS reveals .ts-data-table when text-only is active. */}
      <table className="ts-data-table" aria-label="Данни от диаграмата">
        <thead>
          <tr>
            <th scope="col">Категория</th>
            <th scope="col">Стойност</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td>{row.label}</td>
              <td>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="report-bar" role="list" aria-hidden="true">
        {rows.map((row, i) => (
          <li key={i} className="report-bar__row">
            <span className="report-bar__fill" style={{ width: `${row.pct}%` }} />
            <span className="report-bar__label">{row.label}</span>
            <span className="report-bar__value num">{row.value}</span>
          </li>
        ))}
      </ul>
      {truncated && (
        <p className="report-block__truncated-note">
          Показани са само първите резултати — данните са отрязани.
        </p>
      )}
    </div>
  );
}

// ── Flows ─────────────────────────────────────────────────────────────────────

function FlowsBlock({
  edges,
  truncated,
}: {
  edges: { from: string; to: string; valueEur: number }[];
  truncated?: boolean;
}) {
  if (edges.length === 0) return <p className="chart-empty">Няма данни</p>;
  return (
    <div className="report-block report-block--flows">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">От</th>
              <th scope="col">Към</th>
              <th scope="col" className="num">
                Стойност (€)
              </th>
            </tr>
          </thead>
          <tbody>
            {edges.map((e, i) => (
              <tr key={i}>
                <td>{e.from}</td>
                <td>{e.to}</td>
                <td className="num">{money(e.valueEur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && (
        <p className="report-block__truncated-note">
          Показани са само първите резултати — данните са отрязани.
        </p>
      )}
    </div>
  );
}

// ── Single block ──────────────────────────────────────────────────────────────

function Block({ block }: { block: ResolvedBlock }) {
  switch (block.type) {
    case 'text':
      return <MarkdownBlock md={block.md} className="report-block report-block--text" />;

    case 'callout':
      return <CalloutBlock title={block.title} md={block.md} />;

    case 'totals': {
      const totals = block.items.map((it) => ({
        num: formatCell(it.value, it.format),
        label: it.label,
      }));
      return (
        <div className="report-block report-block--totals">
          <TotalsStrip totals={totals} />
        </div>
      );
    }

    case 'facts': {
      const rows = block.items.map((it) => ({
        term: it.term,
        value: formatCell(it.value, 'text'),
        sub: it.sub,
      }));
      return (
        <div className="report-block report-block--facts">
          <FactsList rows={rows} />
        </div>
      );
    }

    case 'table': {
      if (block.rows.length === 0) {
        return (
          <div className="report-block report-block--table">
            <p className="chart-empty">Няма резултати</p>
          </div>
        );
      }
      const columns = block.columns.map((col, ci) => ({
        key: col.key,
        header: col.header,
        align: col.align === 'right' ? ('num' as const) : undefined,
        cell: (row: (typeof block.rows)[number]) => {
          const value = formatCell(row.cells[ci] ?? null, col.format);
          if (col.link && row.links?.[ci]) {
            const href = entityHref(col.link.kind, row.links[ci]!);
            return <Link to={href}>{value}</Link>;
          }
          return value;
        },
      }));
      return (
        <div className="report-block report-block--table">
          <DataTable columns={columns} rows={block.rows} getKey={(_, i) => i} />
          {block.truncated && (
            <p className="report-block__truncated-note">
              Показани са само първите резултати — данните са отрязани.
            </p>
          )}
        </div>
      );
    }

    case 'bar':
      return <BarBlock points={block.points} truncated={block.truncated} format={block.format} />;

    case 'flows':
      return <FlowsBlock edges={block.edges} truncated={block.truncated} />;

    case 'timeseries':
      return (
        <div className="report-block report-block--timeseries">
          <TimeseriesBlock
            points={block.points}
            truncated={block.truncated}
            format={block.format}
          />
        </div>
      );

    case 'weekbars': {
      // `block.previous` is REQUIRED on the resolved weekbars type (report-schema.ts) — the binder
      // always sets it (`previous: series(prev)`), so reading it unconditionally is safe here even
      // though the standalone WeeklyGhostBars accepts `previous` as optional for reuse elsewhere.
      const toDays = (series: { label: string | number | null; value: number }[]) =>
        series.map((d) => ({ label: d.label == null ? '' : String(d.label), value: d.value }));
      return (
        <div className="report-block report-block--weekbars">
          <WeeklyGhostBars current={toDays(block.current)} previous={toDays(block.previous)} />
        </div>
      );
    }

    default:
      return null;
  }
}

interface ReportBlockRendererProps {
  blocks: ResolvedBlock[];
  // Optional per-block heading, aligned by index to `blocks` (null = no heading). Lets a caller label
  // otherwise-unlabelled sections — the weekly digest names its charts/table („Стойност по сектори",
  // „Конкуренция", „Най-големи договори", …) so a reader knows what each one shows. Absent for the chat
  // report pipeline, whose output is unchanged.
  captions?: (string | null)[];
}

/**
 * Renders a list of resolved report blocks. Each block type maps to its own component.
 * Text and callout blocks are always rendered through MarkdownBlock (no raw HTML, safe links).
 */
export function ReportBlockRenderer({ blocks, captions }: ReportBlockRendererProps) {
  return (
    <div className="report-blocks">
      {blocks.map((block, i) => {
        // Key by type + position: a report's block list is immutable and never reorders, so this is
        // stable across streaming re-renders while keeping React's reconciliation type-aware.
        const caption = captions?.[i] ?? null;
        if (!caption) return <Block key={`${block.type}-${i}`} block={block} />;
        return (
          <section key={`${block.type}-${i}`} className="report-block-group">
            <h2 className="report-block__heading">{caption}</h2>
            <Block block={block} />
          </section>
        );
      })}
    </div>
  );
}
