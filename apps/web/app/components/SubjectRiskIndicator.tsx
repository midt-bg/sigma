import { Link } from 'react-router';
import { count, pct } from '@sigma/shared';
import { Callout } from './ui';
import type { RiskBandKey, RiskComponentKey, SubjectRiskView } from '../lib/subjectRisk';

const BAND_LABEL: Record<RiskBandKey, string> = {
  few: 'Малко индикатори',
  some: 'Единични индикатори',
  many: 'Множество индикатори',
  most: 'Много индикатори — заслужава преглед',
};

const COMPONENT_LABEL: Record<RiskComponentKey, string> = {
  single_offer: 'Една оферта',
  high_markup: 'Високо оскъпяване',
};

// Each component's „виж договорите" links to exactly the contracts it counts, so every number on the
// page is traceable (the drill-down control, M7). The value is the same predicate the rollup
// materializes: bids=1 ⇒ c.bids_received = 1, markup=high ⇒ c.is_high_markup = 1 (@sigma/db filters).
const COMPONENT_FILTER: Record<RiskComponentKey, string> = {
  single_offer: 'bids=1',
  high_markup: 'markup=high',
};

// Subject-level risk. Rendered ONLY when buildSubjectRisk returned a view (natural persons and thin
// samples are already suppressed upstream). The framing, the band, the counts and the drill-down are one
// atomic block (M8) — the disclaimer never renders apart from the number, and the caller keeps this out
// of <meta>/OG so it can't become a search snippet.
export function SubjectRiskIndicator({
  risk,
  contractsBase,
}: {
  risk: SubjectRiskView;
  contractsBase: string; // e.g. '/contracts?bidder=eik:123' — already carries a query string
}) {
  return (
    <Callout variant="neutral">
      <p className="m-0">
        Обобщава колко от договорите на субекта имат рискови признаци. Неутрален индикатор — не
        оценява процедурите и не маркира субекта като нарушител. Изводите прави потребителят.{' '}
        <Link to="/methodology#risk">Методология</Link>.
      </p>
      <p className="subject-risk-band">{BAND_LABEL[risk.band]}</p>
      <ul className="subject-risk-list">
        {risk.components.map((c) => (
          <li key={c.key}>
            <strong>{COMPONENT_LABEL[c.key]}:</strong> {count(c.k)} от {count(c.n)} договора
            {c.valueShare != null ? <> · {pct(c.valueShare)} от стойността</> : null} ·{' '}
            <Link to={`${contractsBase}&${COMPONENT_FILTER[c.key]}`}>виж договорите</Link>
          </li>
        ))}
      </ul>
    </Callout>
  );
}
