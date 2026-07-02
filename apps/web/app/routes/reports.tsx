import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { loadReportIndex, type ReportIndexEntry } from '~/lib/assistant-dock/storage';

// Per-browser report index (spec §5: "без глобално изброяване").
// The index is built from localStorage as reports are generated in this browser — no server
// enumeration, so each visitor sees only the reports they created. The dock writes to
// sigma.reports.index via addToReportIndex when a storedId arrives in the transcript.

export function meta() {
  return [{ title: 'AI справки — СИГМА' }, { name: 'robots', content: 'noindex' }];
}

export function headers() {
  return { 'Cache-Control': 'no-store' };
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  try {
    return d.toLocaleDateString('bg-BG', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  try {
    return d.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function ReportsIndexPage() {
  const [reports, setReports] = useState<ReportIndexEntry[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReports(loadReportIndex());
    setReady(true);
  }, []);

  return (
    <main id="main" className="reports-index">
      <header className="reports-index__header">
        <p className="reports-index__eyebrow">AI справки</p>
        <h1 className="reports-index__title">Генерирани справки</h1>
        <p className="reports-index__description">
          Справките са съставени автоматично от езиков модел и не представляват официални документи.
          Проверявайте критични числа от първичен източник.
        </p>
      </header>

      {ready && reports.length === 0 ? (
        <div className="reports-index__empty">
          <p>Няма генерирани справки.</p>
          <p>
            Задайте въпрос в{' '}
            <Link to="/" className="reports-index__empty-link">
              асистента
            </Link>{' '}
            и справката ще се появи тук.
          </p>
        </div>
      ) : (
        <ol className="reports-list">
          {reports.map((r) => (
            <li key={r.id} className="reports-list__item">
              <Link to={`/reports/${r.id}`} className="reports-list__link">
                <span className="reports-list__title">{r.title}</span>
                {r.question && r.question !== r.title && (
                  <span className="reports-list__question">{r.question}</span>
                )}
              </Link>
              <time className="reports-list__date" dateTime={r.createdAt}>
                {fmtDate(r.createdAt)}
                {' · '}
                {fmtTime(r.createdAt)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
