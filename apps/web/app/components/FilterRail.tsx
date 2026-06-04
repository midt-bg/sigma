import type { FormEvent } from 'react';
import { Form, Link, useNavigate, useSearchParams } from 'react-router';
import { count as fmtCount } from '@sigma/shared';
import { withParams } from '../lib/filters';

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

export interface FilterGroup {
  key: string; // URL param name (also the input `name`)
  label: string;
  type: 'checkbox' | 'radio';
  options: FilterOption[];
  selected: string[];
  allLabel?: string; // radio groups: the „Всички" (clear) option label
  more?: { href: string; label: string };
}

// Sticky filter rail. Filters live in the URL (shareable). A `<Form method="get">` auto-submits on
// change when JS is on (instant filtering) and still works via the visible button without JS. The
// current `sort` is preserved through a hidden field; `cursor`/`page` are intentionally omitted so a
// new filter resets to page 1.
//
// All groups render expanded by default so the available filters are visible at a glance; the visitor
// can collapse any of them by clicking its summary (the `<details>` element preserves that local
// state in the browser without us tracking it).
export function FilterRail({
  groups,
  sort,
  clearHref,
  csvHref,
}: {
  groups: FilterGroup[];
  sort: string;
  clearHref: string;
  csvHref?: string;
}) {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const preservedScope = ['authority', 'bidder'].flatMap((key) =>
    sp.getAll(key).map((value) => ({ key, value })),
  );
  const groupKeys = groups.map((g) => g.key);
  const onChange = (e: FormEvent<HTMLFormElement>) => {
    const form = e.currentTarget;
    const data = new FormData(form);
    const overrides: Record<string, string | string[] | null> = {
      sort: String(data.get('sort') ?? sort),
      cursor: null,
      page: null,
    };
    for (const key of groupKeys) {
      overrides[key] = data.getAll(key).map(String).filter(Boolean);
    }
    navigate(withParams(sp, overrides));
  };
  return (
    <aside className="filter-rail" aria-label="Филтри">
      {/* The rail is always visible on desktop. When the layout stacks to one column it collapses
          behind the „Филтри" label, toggled by an off-screen checkbox — a CSS-only disclosure
          (see app.css), so it needs no JS and renders identically on the server and the client. */}
      <input
        type="checkbox"
        id="filter-rail-toggle"
        className="filter-rail-toggle"
        aria-label="Покажи или скрий филтрите"
      />
      <label htmlFor="filter-rail-toggle" className="filter-rail-summary">
        Филтри
      </label>
      <Form method="get" onChange={onChange}>
        <input type="hidden" name="sort" value={sort} />
        {preservedScope.map(({ key, value }) => (
          <input type="hidden" name={key} value={value} key={`${key}-${value}`} />
        ))}
        {groups.map((g) => {
          return (
            <details className="filter-group" key={g.key} open>
              <summary>
                {g.label}
                {g.selected.length > 0 && (
                  <span className="filter-count">{fmtCount(g.selected.length)}</span>
                )}
              </summary>
              {g.type === 'radio' && (
                <label className="check">
                  <input
                    type="radio"
                    name={g.key}
                    value=""
                    checked={g.selected.length === 0}
                    onChange={() => {}}
                  />{' '}
                  {g.allLabel ?? 'Всички'}
                </label>
              )}
              {g.options.map((o) => (
                <label className="check" key={o.value}>
                  <input
                    type={g.type}
                    name={g.key}
                    value={o.value}
                    checked={g.selected.includes(o.value)}
                    onChange={() => {}}
                  />{' '}
                  {o.label}
                  {o.count != null && <span className="muted small">{fmtCount(o.count)}</span>}
                </label>
              ))}
              {g.more && (
                <p className="small muted" style={{ marginTop: 'var(--s-2)' }}>
                  <Link to={g.more.href}>{g.more.label} →</Link>
                </p>
              )}
            </details>
          );
        })}
        <noscript>
          <button type="submit" className="filter-apply">
            Покажи резултатите
          </button>
        </noscript>
        <p className="small muted" style={{ marginTop: 'var(--s-4)' }}>
          <Link to={clearHref}>Изчисти филтрите</Link>
          {csvHref && (
            <>
              {' · '}
              <a href={csvHref}>Изтегли CSV</a>
            </>
          )}
        </p>
      </Form>
    </aside>
  );
}
