import { Link } from 'react-router';
import { count, date, money } from '@sigma/shared';
import type { ContractListItem } from '@sigma/api-contract';
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
  const colLabel = counterparty === 'authority' ? 'Институция' : 'Изпълнител';
  const caption =
    counterparty === 'authority' ? 'Договори на компанията' : 'Договори на институцията';
  return (
    <div className="table-wrap tbl-cards">
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Дата</th>
            <th scope="col">Предмет</th>
            <th scope="col">{colLabel}</th>
            <th scope="col">Процедура</th>
            <th scope="col" className="num-left">
              Оферти
            </th>
            <th scope="col" className="num">
              Стойност
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td className="nowrap" data-label="Дата">
                {date(c.signedAt)}
              </td>
              <td className="cell-title" data-label="Предмет">
                <Link to={`/contracts/${c.id}`}>{c.subject}</Link>
                <br />
                <span className="small muted">УНП {c.unp}</span>
              </td>
              <td data-label={colLabel}>
                {counterparty === 'authority' ? (
                  <Link to={`/authorities/${c.authoritySlug}`}>{c.authorityName}</Link>
                ) : (
                  <Link to={`/companies/${c.bidderSlug}`}>{c.bidderDisplayName}</Link>
                )}
              </td>
              <td data-label="Процедура">
                <Chip>{c.procedureLabel}</Chip>
              </td>
              <td className="num-left" data-label="Оферти">
                {c.bidsReceived != null ? count(c.bidsReceived) : '—'}
              </td>
              <td className="money" data-label="Стойност">
                {c.valueEur != null ? (
                  money(c.valueEur)
                ) : (
                  <span className="suspect">проверяват</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
