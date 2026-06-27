import { count, money, pct } from '@sigma/shared';

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
  scopeLabel?: string;
  captionSuffix?: string;
}) {
  const ratio = Math.min(1, Math.max(0, totalEur > 0 ? valueEur / totalEur : 0));
  const headline = scopeLabel ? `от стойността ${scopeLabel} са` : 'от стойността е';
  const hasCounts = singleOffer != null && contracts != null;

  return (
    <div className="so-portion">
      <p className="so-portion-head">
        <span className="so-portion-pct">{pct(ratio)}</span> {headline} по договори с{' '}
        <em>една оферта</em>.
      </p>
      <div className="hbar" aria-hidden="true">
        <span style={{ width: `${(ratio * 100).toFixed(1)}%`, background: 'var(--accent)' }} />
        <span
          style={{ width: `${((1 - ratio) * 100).toFixed(1)}%`, background: 'var(--ink-soft)' }}
        />
      </div>
      <p className="small muted so-portion-cap">
        {hasCounts && (
          <>
            {count(singleOffer)} от {count(contracts)} договора ·{' '}
          </>
        )}
        {money(valueEur)} от {money(totalEur)}
        {captionSuffix ? ` ${captionSuffix}` : ''}
      </p>
    </div>
  );
}
