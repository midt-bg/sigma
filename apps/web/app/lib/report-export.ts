import type { ResolvedReport, CellFormat } from '~/lib/assistant-contract/report';
import { money, count, pct } from '@sigma/shared';

function fmt(value: string | number | null, format?: CellFormat): string {
  if (value === null || value === undefined) return '—';
  if (format === 'money') return money(typeof value === 'number' ? value : Number(value));
  if (format === 'percent') return pct(typeof value === 'number' ? value : Number(value));
  if (format === 'number') return count(typeof value === 'number' ? value : Number(value));
  return String(value);
}

function mdTable(headers: string[], rows: string[][]): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `| ${headers.map(esc).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n');
}

export function reportToMarkdown(report: ResolvedReport): string {
  const lines: string[] = [`# ${report.title}`, ''];
  if (report.question) lines.push(`_${report.question}_`, '');

  for (const block of report.blocks) {
    switch (block.type) {
      case 'text':
        lines.push(block.md, '');
        break;
      case 'callout':
        lines.push(`> **${block.title}**`, ...block.md.split('\n').map((l) => `> ${l}`), '');
        break;
      case 'totals':
        lines.push(
          mdTable(
            ['Показател', 'Стойност'],
            block.items.map((i) => [i.label, fmt(i.value, i.format)]),
          ),
          '',
        );
        break;
      case 'facts':
        lines.push(
          mdTable(
            ['Поле', 'Стойност'],
            block.items.map((r) => [
              r.term,
              r.sub ? `${String(r.value ?? '—')} _(${r.sub})_` : String(r.value ?? '—'),
            ]),
          ),
          '',
        );
        break;
      case 'table':
        lines.push(
          mdTable(
            block.columns.map((c) => c.header),
            block.rows.map((row) =>
              block.columns.map((c, ci) => fmt(row.cells[ci] ?? null, c.format)),
            ),
          ),
          '',
        );
        break;
      case 'bar':
        lines.push(
          ...block.points.map(
            (pt, i) => `${i + 1}. ${pt.label ?? '—'} — ${fmt(pt.value, block.format ?? 'money')}`,
          ),
          '',
        );
        break;
      case 'flows':
        lines.push(
          mdTable(
            ['Възложител', 'Изпълнител', 'Стойност (EUR)'],
            block.edges.map((e) => [e.from, e.to, money(e.valueEur)]),
          ),
          '',
        );
        break;
      case 'timeseries': {
        const pts = block.points ?? [];
        lines.push(
          mdTable(
            ['Период', 'Стойност'],
            pts.map(({ period, value }) => [
              String(period ?? ''),
              fmt(value, block.format ?? 'money'),
            ]),
          ),
          '',
        );
        break;
      }
    }
  }

  lines.push('---', '_AI-генерирано, неофициално — СИГМА_');
  return lines.join('\n');
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer the revoke to a later tick: some browsers (notably Firefox) may not have started reading
  // the blob when the synchronous click() returns, and revoking in the same task aborts the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function safeFilename(title: string, ext: string): string {
  const base = title
    .slice(0, 50)
    .replace(/[^а-яa-z0-9]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // A title with no [а-яa-z0-9] chars (emoji/CJK/punctuation-only) sanitizes to '', which would
  // produce a blank, hidden-named download like `.docx`. Fall back to a stable default base.
  return `${base || 'report'}.${ext}`;
}

export async function reportToDocxBlob(report: ResolvedReport): Promise<Blob> {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    Table,
    TableRow,
    TableCell,
    HeadingLevel,
    WidthType,
    AlignmentType,
    BorderStyle,
  } = await import('docx');

  const children: (typeof Paragraph.prototype | typeof Table.prototype)[] = [];

  children.push(
    new Paragraph({
      text: report.title,
      heading: HeadingLevel.HEADING_1,
    }),
  );

  if (report.question) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: report.question, italics: true })],
        spacing: { after: 200 },
      }),
    );
  }

  for (const block of report.blocks) {
    switch (block.type) {
      case 'text':
        for (const para of block.md.split(/\n{2,}/).filter(Boolean)) {
          children.push(
            new Paragraph({ text: para.replace(/[*_`]/g, ''), spacing: { after: 120 } }),
          );
        }
        break;

      case 'callout':
        children.push(
          new Paragraph({
            children: [new TextRun({ text: block.title, bold: true })],
            spacing: { before: 160, after: 80 },
          }),
          new Paragraph({
            text: block.md.replace(/[*_`]/g, ''),
            spacing: { after: 200 },
          }),
        );
        break;

      case 'totals':
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                children: block.items.map(
                  (it) =>
                    new TableCell({
                      children: [
                        new Paragraph({
                          children: [
                            new TextRun({ text: fmt(it.value, it.format), bold: true, size: 28 }),
                          ],
                        }),
                        new Paragraph({
                          children: [new TextRun({ text: it.label, size: 18, color: '666666' })],
                        }),
                      ],
                    }),
                ),
              }),
            ],
          }),
        );
        break;

      case 'facts':
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: block.items.map(
              (it) =>
                new TableRow({
                  children: [
                    new TableCell({
                      children: [
                        new Paragraph({ children: [new TextRun({ text: it.term, bold: true })] }),
                      ],
                    }),
                    new TableCell({ children: [new Paragraph({ text: String(it.value ?? '—') })] }),
                  ],
                }),
            ),
          }),
        );
        break;

      case 'table': {
        const headerRow = new TableRow({
          children: block.columns.map(
            (col) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: col.header,
                        bold: true,
                        allCaps: true,
                        size: 18,
                        color: '666666',
                      }),
                    ],
                  }),
                ],
              }),
          ),
        });
        const dataRows = block.rows.map(
          (row) =>
            new TableRow({
              children: block.columns.map(
                (col, ci) =>
                  new TableCell({
                    children: [
                      new Paragraph({
                        text: fmt(row.cells[ci] ?? null, col.format),
                        alignment: col.align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT,
                      }),
                    ],
                  }),
              ),
            }),
        );
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [headerRow, ...dataRows],
          }),
        );
        break;
      }

      case 'bar':
        for (const pt of block.points) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({ text: `${pt.label ?? '—'}`, bold: false }),
                new TextRun({ text: `  ${fmt(pt.value, block.format ?? 'money')}`, bold: true }),
              ],
              spacing: { after: 60 },
            }),
          );
        }
        break;

      case 'flows':
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                children: ['Възложител', 'Изпълнител', 'Стойност (EUR)'].map(
                  (h) =>
                    new TableCell({
                      children: [
                        new Paragraph({ children: [new TextRun({ text: h, bold: true })] }),
                      ],
                    }),
                ),
              }),
              ...block.edges.map(
                (e) =>
                  new TableRow({
                    children: [e.from, e.to, money(e.valueEur)].map(
                      (v) => new TableCell({ children: [new Paragraph({ text: v })] }),
                    ),
                  }),
              ),
            ],
          }),
        );
        break;

      case 'timeseries': {
        const pts = block.points ?? [];
        children.push(
          new Table({
            width: { size: 60, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                children: ['Период', 'Стойност'].map(
                  (h) =>
                    new TableCell({
                      children: [
                        new Paragraph({ children: [new TextRun({ text: h, bold: true })] }),
                      ],
                    }),
                ),
              }),
              ...pts.map(
                ({ period, value }) =>
                  new TableRow({
                    children: [String(period ?? ''), fmt(value, block.format ?? 'money')].map(
                      (v) => new TableCell({ children: [new Paragraph({ text: v })] }),
                    ),
                  }),
              ),
            ],
          }),
        );
        break;
      }
    }

    children.push(new Paragraph({ text: '', spacing: { after: 160 } }));
  }

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: 'AI-генерирано, неофициално — СИГМА',
          italics: true,
          color: '888888',
          size: 18,
        }),
      ],
      spacing: { before: 400 },
      border: { top: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
    }),
  );

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}
