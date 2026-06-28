import type { ContractDetail } from '@sigma/api-contract';
import { pct } from '@sigma/shared';
import { evaluateRiskIndicators } from '../lib/riskLogic';
import { useTranslation, useLocale } from '../i18n/context';

export function RiskIndicators({ contract }: { contract: ContractDetail }) {
  const t = useTranslation();
  const locale = useLocale();
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
        {t('riskIndicators.title')}
      </h2>
      <ul className="risk-list">
        {flags.map((flag, i) => {
          if (flag.type === 'eu_no_competition') {
            return (
              <li key={i}>
                <strong>{t('riskIndicators.euLabel')}</strong> {t('riskIndicators.euBody')}
              </li>
            );
          }
          if (flag.type === 'no_competition') {
            return (
              <li key={i}>
                <strong>{t('riskIndicators.noCompLabel')}</strong> {t('riskIndicators.noCompBody')}
              </li>
            );
          }
          if (flag.type === 'high_markup') {
            return (
              <li key={i}>
                <strong>{t('riskIndicators.markupLabel')}</strong>{' '}
                {t('riskIndicators.markupBody', { pct: pct(flag.deltaPct!, 1, locale) })}
              </li>
            );
          }
          if (flag.type === 'anomalies') {
            return (
              <li key={i}>
                <strong>{t('riskIndicators.anomaliesLabel')}</strong>{' '}
                {t('riskIndicators.anomaliesBody')}
              </li>
            );
          }
          return null;
        })}
      </ul>
    </div>
  );
}
