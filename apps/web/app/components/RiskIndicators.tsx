import type { ContractDetail } from '@sigma/api-contract';
import { pct } from '@sigma/shared';

export function RiskIndicators({ contract }: { contract: ContractDetail }) {
  const flags: React.ReactNode[] = [];

  const admitted =
    contract.bidsReceived != null ? contract.bidsReceived - (contract.bidsRejected || 0) : null;

  if (admitted === 1) {
    if (contract.euFunded) {
      // 2. Риск при европейско финансиране (по-силно от липса на конкуренция)
      flags.push(
        <>
          <strong>Риск при Еврофондове:</strong> Проектът е финансиран с европейски средства, но е
          възложен без реална конкуренция (повишен риск според стандартите на ОЛАФ).
        </>,
      );
    } else {
      // 1. Липса на конкуренция (Единствен допуснат кандидат)
      flags.push(
        <>
          <strong>Липса на конкуренция:</strong> Този договор е сключен след допускане на само една
          оферта.
        </>,
      );
    }
  }

  // 3. Значително оскъпяване (над 20%) чрез анекси
  if (contract.value.deltaPct != null && contract.value.deltaPct > 0.2) {
    flags.push(
      <>
        <strong>Значително оскъпяване:</strong> Стойността на договора е нараснала с{' '}
        {pct(contract.value.deltaPct)} спрямо първоначално обявената чрез допълнителни анекси.
      </>,
    );
  }

  // 4. Аномалии в данните на АОП
  if (contract.dateSuspect || contract.value.suspect) {
    flags.push(
      <>
        <strong>Аномалии в данните:</strong> Стойността на договора (или някои от датите) е извън
        обичайния диапазон и подлежи на допълнителна проверка.
      </>,
    );
  }

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
        {flags.map((flag, i) => (
          <li key={i}>{flag}</li>
        ))}
      </ul>
    </div>
  );
}
