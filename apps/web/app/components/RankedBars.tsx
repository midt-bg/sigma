import { Link } from '../i18n/Link';
import { money } from '@sigma/shared';
import { useLocale } from '../i18n/context';

// Horizontal ranked bar chart — CSS only, no chart lib (same spirit as StackedBar). Each row is a
// link to the authority; a soft fill bar behind the label is proportional to spend (scaled to the
// column max). Items must already be sorted descending by spentEur.
export function RankedBars({
  items,
}: {
  items: { slug: string; name: string; spentEur: number }[];
}) {
  const locale = useLocale();
  const max = Math.max(1, ...items.map((i) => i.spentEur));
  return (
    <ul className="ranked-bars">
      {items.map((a) => (
        <li key={a.slug}>
          <Link to={`/authorities/${a.slug}`}>
            <span
              className="rb-fill"
              style={{ width: `${Math.max(3, (a.spentEur / max) * 100).toFixed(1)}%` }}
              aria-hidden="true"
            />
            <span className="rb-name">{a.name}</span>
            <span className="rb-val num">{money(a.spentEur, locale)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
