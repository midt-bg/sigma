import { count, money, pct } from '@sigma/shared';
import { useTranslation, useLocale } from '../i18n/context';

export function SingleOfferPortion({
  valueEur,
  totalEur,
  singleOffer,
  contracts,
  scopeLabel,
  captionSuffix,
}: {
  valueEur: number;
  totalEur: number;
  singleOffer?: number;
  contracts?: number;
  // Already-translated strings supplied by callers (e.g. `t('authority.soScope')`).
  scopeLabel?: string;
  captionSuffix?: string;
}) {
  const t = useTranslation();
  const locale = useLocale();
  const ratio = Math.min(1, Math.max(0, totalEur > 0 ? valueEur / totalEur : 0));
  const scope = scopeLabel ?? t('singleOffer.defaultScope');
  const hasCounts = singleOffer != null && contracts != null;

  return (
    <div className="so-portion">
      <p className="so-portion-head">
        <span className="so-portion-pct">{pct(ratio, undefined, locale)}</span>
        {t('singleOffer.headPre')}
        {scope}
        {t('singleOffer.headPost')}
        <em>{t('singleOffer.headEm')}</em>
        {t('singleOffer.headEnd')}
      </p>
      <div className="hbar" aria-hidden="true">
        <span style={{ width: `${(ratio * 100).toFixed(1)}%`, background: 'var(--accent)' }} />
        <span
          style={{ width: `${((1 - ratio) * 100).toFixed(1)}%`, background: 'var(--ink-soft)' }}
        />
      </div>
      <p className="small muted so-portion-cap">
        {hasCounts &&
          t('singleOffer.capCounts', {
            singleOffer: count(singleOffer, locale),
            contracts: count(contracts, locale),
          })}
        {t('singleOffer.capValue', {
          value: money(valueEur, locale),
          total: money(totalEur, locale),
        })}
        {captionSuffix ? ` ${captionSuffix}` : ''}
      </p>
    </div>
  );
}
