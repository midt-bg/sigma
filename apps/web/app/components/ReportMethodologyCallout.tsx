// D5 + D6: "Как е изчислено" methodology callout + per-source freshness (spec §D5, §D6).
//
// Shows: what was measured (the asked question), how each result set was obtained (tool + SQL),
// per-source data freshness dates, and the model / prompt version that produced the report.
// Rendered on every /reports/:id page as the authoritative provenance footer.

import type {
  ReportProvenance,
  SourceFreshness,
  FreshnessSource,
} from '~/lib/assistant-contract/report';

// Bulgarian labels for each data source.
const SOURCE_LABELS: Record<FreshnessSource, string> = {
  admin: 'Администрация (ЦАИС АОП)',
  ocds: 'OCDS',
  eop: 'Е-ОП',
};

/**
 * Per-source freshness row — D6: surface asOf per source, not a single global timestamp.
 */
function FreshnessList({ freshness }: { freshness: SourceFreshness[] }) {
  if (freshness.length === 0) return null;
  return (
    <dl className="report-freshness">
      {freshness.map((f) => (
        <div key={f.source} className="report-freshness__row">
          <dt className="report-freshness__source">{SOURCE_LABELS[f.source] ?? f.source}</dt>
          <dd className="report-freshness__date">
            <time dateTime={f.asOf}>{f.asOf}</time>
          </dd>
        </div>
      ))}
    </dl>
  );
}

interface ReportMethodologyCalloutProps {
  provenance: ReportProvenance;
}

/**
 * "Как е изчислено" disclosure section — D5.
 * Surfaces measure (question), scope (SQL / tool per handle), excluded flags visible in the SQL,
 * per-source freshness (D6), model, and prompt version.
 */
export function ReportMethodologyCallout({ provenance }: ReportMethodologyCalloutProps) {
  return (
    <details className="report-methodology" open={false}>
      <summary className="report-methodology__summary">Как е изчислено</summary>

      <div className="report-methodology__body">
        <section className="report-methodology__section">
          <h2 className="report-methodology__heading">Въпрос</h2>
          <p className="report-methodology__question">{provenance.question}</p>
        </section>

        {provenance.sources.length > 0 && (
          <section className="report-methodology__section">
            <h2 className="report-methodology__heading">Източници на данни</h2>
            <ul className="report-methodology__sources">
              {provenance.sources.map((src) => (
                <li key={src.handle} className="report-methodology__source-item">
                  <span className="report-methodology__handle">{src.handle}</span>
                  <span className="report-methodology__tool">{src.tool}</span>
                  {src.sql && (
                    <details className="report-methodology__sql-details">
                      <summary>Виж заявката</summary>
                      <pre className="report-methodology__sql">
                        <code>{src.sql}</code>
                      </pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="report-methodology__section">
          <h2 className="report-methodology__heading">Актуалност на данните</h2>
          {provenance.freshness.length > 0 ? (
            <FreshnessList freshness={provenance.freshness} />
          ) : (
            <p className="report-methodology__freshness-na">
              Няма налична информация за актуалността на данните.
            </p>
          )}
        </section>

        <section className="report-methodology__section report-methodology__meta">
          <dl className="report-methodology__meta-list">
            <div>
              <dt>Модел</dt>
              <dd>
                <code>{provenance.model}</code>
              </dd>
            </div>
            <div>
              <dt>Версия на подканата</dt>
              <dd>
                <code>{provenance.promptVersion}</code>
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </details>
  );
}
