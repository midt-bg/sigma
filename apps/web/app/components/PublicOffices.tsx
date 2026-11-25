import { describeOffices, officeTitle, officeYearsText, type OfficeFiling } from '@sigma/shared';

/**
 * A person's public offices under their name, one plain line each: the position — with „Бивш" in front of it
 * when the rule in `describeOffices` allows — then the institution and the years. A former office reads
 * „Бивш кмет · Община Тестово · 2015–2019"; an office with no end on record reads „Кмет · Община Тестово ·
 * декларации за 2019–2023", which claims neither that it goes on nor that it ended. The status is a word in the
 * line, never a colour and never a second line the reader has to reconcile with the first.
 */
export function PublicOffices({
  filings,
  label = 'Длъжности според декларациите',
}: {
  filings: OfficeFiling[] | undefined;
  label?: string | null;
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
          return (
            <li key={`${i}-${o.institution}`}>
              {title && <span className="office-title">{title}</span>}
              <span className={title ? 'muted' : undefined}>
                {title && ' · '}
                {o.institution}
              </span>
              {years && <span className="muted"> · {years}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
