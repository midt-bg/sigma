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
  return (
    <div className="report-block report-block--bar">
      <ul className="report-bar" role="list">
        {points.map((p, i) => {
          const pct = ((p.value / max) * 100).toFixed(1);
          const label = p.label == null || p.label === '' ? '—' : String(p.label);
          return (
            <li key={i} className="report-bar__row">
              <span className="report-bar__fill" style={{ width: `${pct}%` }} aria-hidden="true" />
              <span className="report-bar__label">{label}</span>
              <span className="report-bar__value num">
                {formatCell(p.value, format ?? 'money')}
              </span>
            </li>
          );
        })}
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

    default:
      return null;
  }
}

interface ReportBlockRendererProps {
  blocks: ResolvedBlock[];
}

/**
 * Renders a list of resolved report blocks. Each block type maps to its own component.
 * Text and callout blocks are always rendered through MarkdownBlock (no raw HTML, safe links).
 */
export function ReportBlockRenderer({ blocks }: ReportBlockRendererProps) {
  return (
    <div className="report-blocks">
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}
