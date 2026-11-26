import {
  describeOffices,
  officeFilingDaysText,
  officeTitle,
  officeYearsText,
  type OfficeFiling,
} from '@sigma/shared';

/**
 * A person's public offices under their name, one plain line each: the position — with „Бивш" in front of it
 * when the rule in `describeOffices` allows — then the institution and the years. A former office reads
 * „Бивш кмет · Община Тестово · 2015–2019"; an office with no end on record reads „Кмет · Община Тестово ·
 * декларации за 2019–2023, последна за 2023", which claims neither that it goes on nor that it ended. The
 * status is a word in the line, never a colour and never a second line the reader has to reconcile with the
 * first.
 *
 * `filingDays` adds, where there is room for it (the profile), the days of the entry and the exit declaration
 * in brackets after the years — named as declarations, because a filing day is not a day of the mandate.
 */
export function PublicOffices({
  filings,
  label = 'Длъжности според декларациите',
  filingDays = false,
}: {
  filings: OfficeFiling[] | undefined;
  label?: string | null;
  filingDays?: boolean;
}) {
  const offices = describeOffices(filings ?? []);
  if (!offices.length) return null;
  return (
    <div className="person-institutions">
      {label && <span className="small muted">{label}</span>}
      <ul>
        {offices.map((o, i) => {
          const title = officeTitle(o);
          const years = officeYearsText(o);
          const days = filingDays ? officeFilingDaysText(o) : null;
          return (
            <li key={`${i}-${o.institution}`}>
              {title && <span className="office-title">{title}</span>}
              <span className={title ? 'muted' : undefined}>
                {title && ' · '}
                {o.institution}
              </span>
              {years && (
                <span className="muted">
                  {' '}
                  · {years}
                  {days && ` (${days})`}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
