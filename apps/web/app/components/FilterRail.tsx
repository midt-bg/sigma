import type { ChangeEvent, FormEvent } from 'react';
import { Form, Link, useNavigate, useSearchParams } from 'react-router';
import { count as fmtCount } from '@sigma/shared';
import { withParams } from '../lib/filters';

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

export interface FilterCategory {
  key: string;
  label: string;
  count?: number;
  options: FilterOption[];
}

export interface FilterGroup {
  key: string; // URL param name (also the input `name`)
  label: string;
  type: 'checkbox' | 'radio';
  options?: FilterOption[];
  categories?: FilterCategory[];
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
  const submitForm = (form: HTMLFormElement) => {
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
  const onChange = (e: FormEvent<HTMLFormElement>) => {
    submitForm(e.currentTarget);
  };
  const onCategoryChange = (e: ChangeEvent<HTMLInputElement>, groupKey: string) => {
    e.stopPropagation();
    const input = e.currentTarget;
    const subgroup = input.closest('.filter-subgroup');

    subgroup
      ?.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name]')
      .forEach((member) => {
        if (member.name === groupKey) member.checked = input.checked;
      });

    const form = input.form ?? (input.closest('form') as HTMLFormElement | null);
    if (form) submitForm(form);
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
            <details className="filter-group" key={g.key} open role="group" aria-label={g.label}>
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
              {g.categories
                ? g.categories.map((category) => {
                    const selected = new Set(g.selected);
                    const selectedCount = category.options.filter((option) =>
                      selected.has(option.value),
                    ).length;
                    const allSelected =
                      category.options.length > 0 && selectedCount === category.options.length;
                    const someSelected = selectedCount > 0;

                    return (
                      <details className="filter-subgroup" key={category.key} open={someSelected}>
                        <summary>
                          <input
                            type="checkbox"
                            checked={allSelected}
                            aria-checked={
                              someSelected && !allSelected
                                ? 'mixed'
                                : allSelected
                                  ? 'true'
                                  : 'false'
                            }
                            aria-label={`Избери всички в ${category.label}`}
                            ref={(element) => {
                              if (element) element.indeterminate = someSelected && !allSelected;
                            }}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => onCategoryChange(e, g.key)}
                          />
                          <span className="filter-subgroup-label">{category.label}</span>
                          {category.count != null && (
                            <span className="muted small">{fmtCount(category.count)}</span>
                          )}
                        </summary>
                        {category.options.map((o) => (
                          <label className="check" key={o.value}>
                            <input
                              type={g.type}
                              name={g.key}
                              value={o.value}
                              checked={g.selected.includes(o.value)}
                              onChange={() => {}}
                            />{' '}
                            {o.label}
                            {o.count != null && (
                              <span className="muted small">{fmtCount(o.count)}</span>
                            )}
                          </label>
                        ))}
                      </details>
                    );
                  })
                : (g.options ?? []).map((o) => (
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
                <p className="small muted mt-s2">
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
        <p className="small muted mt-s4">
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
