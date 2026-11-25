import {
  describeOffices,
  officePeriodsText,
  officeStatusText,
  type OfficeFiling,
} from '@sigma/shared';

/**
 * A person's public offices under their name: institution, positions, the years the declarations support
 * and the status the rule in `describeOffices` allows — „Бивш" only with a declaration on leaving that nothing
 * reopens, otherwise the last year on record. The status is words, not a colour.
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
          const status = officeStatusText(o);
          const periods = officePeriodsText(o);
          return (
            <li key={`${i}-${o.institution}`}>
              {o.institution}
              {o.positions.length > 0 && <span className="muted"> · {o.positions.join('; ')}</span>}
              {periods && <span className="muted"> · {periods}</span>}
              {status && (
                <div className={o.status.kind === 'former' ? 'small' : 'small muted'}>{status}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
