import type { ContractDetail } from '@sigma/api-contract';
import { Link } from 'react-router';
import { pct } from '@sigma/shared';
import { evaluateRiskIndicators } from '../lib/riskLogic';

// The per-contract risk signals. Copy is deliberately non-accusatory (#219): each item states the
// structural fact and frames it as a signal that warrants a look, never as proven wrongdoing. The
// note below repeats the disclaimer next to the flags and links to the full methodology, so the
// caveat travels with the flags wherever they appear (issue #219 co-requisite of the risk numbers).
// Labels mirror methodology §10 and the homepage FLAG_LABELS for a consistent vocabulary.
export function RiskIndicators({ contract }: { contract: ContractDetail }) {
  const flags = evaluateRiskIndicators(contract);

  if (flags.length === 0) {
    return null;
  }

  return (
    <div className="risk-indicators">
      <h2 className="risk-title">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
        Сигнали за риск
      </h2>
      <ul className="risk-list">
        {flags.map((flag, i) => {
          if (flag.type === 'eu_no_competition') {
            return (
              <li key={i}>
                <strong>Липса на конкуренция (със средства от ЕС):</strong> проектът е финансиран с
                европейски средства и е допусната само една оферта. Правилата за конкуренция при
                еврофондове са по-строги, затова случаят заслужава преглед.
              </li>
            );
          }
          if (flag.type === 'no_competition') {
            return (
              <li key={i}>
                <strong>Липса на конкуренция:</strong> договорът е сключен след допускане на само
                една оферта.
              </li>
            );
          }
          if (flag.type === 'high_markup') {
            return (
              <li key={i}>
                <strong>Ръст на стойността чрез анекси:</strong> текущата стойност е нараснала с{' '}
                {pct(flag.deltaPct!)} спрямо стойността при подписване.
              </li>
            );
          }
          if (flag.type === 'anomalies') {
            return (
              <li key={i}>
                <strong>Стойностна или времева аномалия:</strong> стойността е с непотвърдена
                достоверност или договорът е подписан преди датата си на публикуване.
              </li>
            );
          }
          return null;
        })}
      </ul>
      <p className="risk-note small muted">
        Сигналите са ориентири за преглед, не присъда — отбелязват договор, който заслужава
        внимание, а не доказано нарушение.{' '}
        <Link to="/methodology#flagged">Как четем сигналите →</Link>
      </p>
    </div>
  );
}
