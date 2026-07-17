import { useState } from 'react';
import type { ResolvedReport } from '~/lib/assistant-contract/report';
import {
  reportToMarkdown,
  reportToDocxBlob,
  downloadBlob,
  safeFilename,
} from '~/lib/report-export';

function IconMarkdown() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" width="14" height="14" fill="currentColor">
      <path d="M2 5h16v10H2V5zm1.5 8.5h1.8l1.2-3 1.2 3h1.8V6.5H7.9v3.6L6.5 6.5H5.3L3.8 10.1V6.5H2.5v7zm8-7v4.7l1.6-1.9 1.6 1.9V6.5H17V13.5h-1.3l-1.6-2-1.6 2H11V6.5z" />
    </svg>
  );
}

function IconDocx() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" width="14" height="14" fill="currentColor">
      <path d="M4 2h8l4 4v12H4V2zm7 1.5V7h3.5L11 3.5zM6 10h8v1H6v-1zm0 2.5h8v1H6v-1zm0-5h4v1H6V7.5z" />
    </svg>
  );
}

function IconPrint() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" width="14" height="14" fill="currentColor">
      <path d="M5 2h10v4H5V2zM3 8h14v7h-3v3H6v-3H3V8zm2 2v4h10v-4H5zm6 5H9v2h2v-2z" />
    </svg>
  );
}

interface ReportToolbarProps {
  report: ResolvedReport;
}

export function ReportToolbar({ report }: ReportToolbarProps) {
  const [docxLoading, setDocxLoading] = useState(false);
  const [docxError, setDocxError] = useState<string | null>(null);

  function handleMarkdown() {
    const md = reportToMarkdown(report);
    const blob = new Blob([md], { type: 'text/markdown; charset=utf-8' });
    downloadBlob(blob, safeFilename(report.title, 'md'));
  }

  async function handleDocx() {
    if (docxLoading) return;
    setDocxError(null);
    setDocxLoading(true);
    try {
      const blob = await reportToDocxBlob(report);
      downloadBlob(blob, safeFilename(report.title, 'docx'));
    } catch {
      setDocxError('Грешка при генериране на .docx файла. Опитайте отново.');
    } finally {
      setDocxLoading(false);
    }
  }

  function handlePrint() {
    window.print();
  }

  return (
    <div className="report-toolbar">
      <button
        type="button"
        className="report-action-btn"
        onClick={handleMarkdown}
        title="Изтегли като Markdown файл"
      >
        <IconMarkdown />
        Markdown
      </button>
      <button
        type="button"
        className="report-action-btn"
        onClick={handleDocx}
        disabled={docxLoading}
        aria-busy={docxLoading}
        title="Изтегли като Word документ (.docx)"
      >
        <IconDocx />
        {docxLoading ? 'Генериране…' : 'Word (.docx)'}
      </button>
      <button
        type="button"
        className="report-action-btn"
        onClick={handlePrint}
        title="Принтирай или запази като PDF"
      >
        <IconPrint />
        Принтирай / PDF
      </button>
      {docxError && (
        <p role="alert" className="report-toolbar__error">
          {docxError}
        </p>
      )}
    </div>
  );
}
