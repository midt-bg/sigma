import { Link } from '../i18n/Link';
import { count, date, money } from '@sigma/shared';
import type { ContractListItem } from '@sigma/api-contract';
import { useLocale, useTranslation } from '../i18n/context';
import { Chip } from './ui';

// A compact contracts table used on detail pages (company top contracts, authority recent contracts).
// `counterparty` chooses which side to show: the authority (on a company page) or the bidder (on an
// authority page). Emits data-label for the JS-free mobile card reflow.
export function ContractMiniTable({
  items,
  counterparty,
}: {
  items: ContractListItem[];
  counterparty: 'authority' | 'bidder';
}) {
  const t = useTranslation();
  const locale = useLocale();
  const colLabel =
    counterparty === 'authority' ? t('contractMiniTable.authority') : t('contractMiniTable.bidder');
  const caption =
    counterparty === 'authority'
      ? t('contractMiniTable.captionCompany')
      : t('contractMiniTable.captionAuthority');
  return (
    <div className="table-wrap tbl-cards">
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t('contractMiniTable.date')}</th>
            <th scope="col">{t('contractMiniTable.subject')}</th>
            <th scope="col">{colLabel}</th>
            <th scope="col">{t('contractMiniTable.procedure')}</th>
            <th scope="col" className="num-left">
              {t('contractMiniTable.bids')}
            </th>
            <th scope="col" className="num">
              {t('contractMiniTable.value')}
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td className="nowrap" data-label={t('contractMiniTable.date')}>
                {date(c.signedAt, locale)}
              </td>
              <td className="cell-title" data-label={t('contractMiniTable.subject')}>
                <Link to={`/contracts/${c.id}`}>{c.subject}</Link>
                <br />
                <span className="small muted">{t('contractMiniTable.unp', { unp: c.unp })}</span>
              </td>
              <td data-label={colLabel}>
                {counterparty === 'authority' ? (
                  <Link to={`/authorities/${c.authoritySlug}`}>{c.authorityName}</Link>
                ) : (
                  <Link to={`/companies/${c.bidderSlug}`}>{c.bidderDisplayName}</Link>
                )}
              </td>
              <td data-label={t('contractMiniTable.procedure')}>
                <Chip>{c.procedureLabel}</Chip>
              </td>
              <td className="num-left" data-label={t('contractMiniTable.bids')}>
                {c.bidsReceived != null ? count(c.bidsReceived, locale) : '—'}
              </td>
              <td className="money" data-label={t('contractMiniTable.value')}>
                {c.valueEur != null ? (
                  money(c.valueEur, locale)
                ) : (
                  <span className="suspect">{t('contractMiniTable.suspect')}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
