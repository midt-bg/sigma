import type { ContractDetail } from '@sigma/api-contract';

export function RiskIndicators({ contract }: { contract: ContractDetail }) {
  const flags: React.ReactNode[] = [];

  // 1. Липса на конкуренция (Единствен кандидат)
  if (contract.bidsReceived === 1) {
    flags.push(
      <>
        <strong>Липса на конкуренция:</strong> Този договор е сключен след получаване на само една
        оферта.
      </>,
    );
  }

  // 2. Риск при европейско финансиране (Кръстосан индикатор)
  if (contract.bidsReceived === 1 && contract.euFunded) {
    flags.push(
      <>
        <strong>Риск при Еврофондове:</strong> Проектът е финансиран с европейски средства, но е
        възложен без реална конкуренция (повишен риск според стандартите на ОЛАФ).
      </>,
    );
  }

  // 3. Значително оскъпяване (над 20%) чрез анекси
  if (contract.value.deltaPct != null && contract.value.deltaPct > 0.2) {
    const deltaStr = (contract.value.deltaPct * 100).toFixed(1).replace('.0', '');
    flags.push(
      <>
        <strong>Значително оскъпяване:</strong> Стойността на договора е нараснала с {deltaStr}%
        спрямо първоначално обявената чрез допълнителни анекси.
      </>,
    );
  }

  // 4. Аномалии в данните на АОП
  if (contract.dateSuspect || contract.value.suspect) {
    flags.push(
      <>
        <strong>Аномалии в данните:</strong> Системата е засякла логически несъответствия в датите
        или стойностите, подадени към АОП от възложителя.
      </>,
    );
  }

  if (flags.length === 0) {
    return null;
  }

  return (
    <div className="risk-indicators">
      <h3 className="risk-title">
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
      </h3>
      <ul className="risk-list">
        {flags.map((flag, i) => (
          <li key={i} className="risk-item">
            {flag}
          </li>
        ))}
      </ul>
    </div>
  );
}
