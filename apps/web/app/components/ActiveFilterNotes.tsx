import { Link } from 'react-router';
import type { HiddenFilter, IgnoredFilter } from '../lib/active-filters';

// Above the results, in the same „… · изчисти" form as the authority/company scope line: an applied filter
// the rail has no option for, and a value in the address the list could not apply. The second never repeats
// the raw value — it is whatever was typed into the address — only the filter it was given for.
export function ActiveFilterNotes({
  hidden,
  ignored,
}: {
  hidden: HiddenFilter[];
  ignored: IgnoredFilter[];
}) {
  return (
    <>
      {hidden.map((f) => (
        <p className="active-filters" key={`hidden-${f.key}-${f.value}`}>
          Активен филтър извън списъка — {f.group}:{' '}
          <strong>{f.label ?? 'непозната стойност'}</strong> ·{' '}
          <Link to={f.removeHref}>
            премахни<span className="sr-only"> {f.label ?? 'непознатата стойност'}</span>
          </Link>
        </p>
      ))}
      {ignored.map((f) => (
        <p className="active-filters" key={`ignored-${f.key}`}>
          Пропусната неподдържана стойност за „{f.group}“ — списъкът не е филтриран по нея ·{' '}
          <Link to={f.removeHref}>махни я от адреса</Link>
        </p>
      ))}
    </>
  );
}
