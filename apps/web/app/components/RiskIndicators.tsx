import type { ContractDetail } from '@sigma/api-contract';
import { pct } from '@sigma/shared';
import { evaluateRiskIndicators } from '../lib/riskLogic';

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
        Индикатори за риск
      </h2>
      <ul className="risk-list">
        {flags.map((flag, i) => {
          if (flag.type === 'eu_no_competition') {
            return (
              <li key={i}>
                <strong>Риск при Еврофондове:</strong> Проектът е финансиран с европейски средства,
                но е възложен без реална конкуренция (повишен риск според стандартите на ОЛАФ).
              </li>
            );
          }
          if (flag.type === 'no_competition') {
            return (
              <li key={i}>
                <strong>Липса на конкуренция:</strong> Този договор е сключен след допускане на само
                една оферта.
              </li>
            );
          }
          if (flag.type === 'high_markup') {
            return (
              <li key={i}>
                <strong>Значително оскъпяване:</strong> Стойността на договора е нараснала с{' '}
                {pct(flag.deltaPct!)} спрямо първоначално обявената — чрез допълнителни анекси.
              </li>
            );
          }
          if (flag.type === 'anomalies') {
            return (
              <li key={i}>
                <strong>Аномалии в данните:</strong> Стойността на договора (или някои от датите) е
                извън обичайния диапазон и подлежи на допълнителна проверка.
              </li>
            );
          }
          return null;
        })}
      </ul>
    </div>
  );
}
