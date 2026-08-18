import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Form, Link, useNavigation, useSearchParams } from 'react-router';
import { count as fmtCount } from '@sigma/shared';
import {
  categorySelectionState,
  filterFormKey,
  preservedParamInputs,
  shouldPruneField,
} from './filterRail.logic';

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

// Filter rail (a sticky sidebar on desktop; the „Търси" bar itself is a fixed floating pill — see
// layout.css). Filters live in the URL (shareable). A native `<Form method="get">` accumulates the
// selection client-side and applies it in ONE navigation when the visitor presses „Търси" — no
// per-toggle Worker request / D1 pass (issue #181). Checkboxes are uncontrolled (`defaultChecked`), so
// they respond instantly and work with JS off. The current `sort` and any `authority`/`bidder` scope
// are preserved through hidden fields; `cursor`/`page` have no field, so the native submit drops them
// and the keyset cursor resets to page 1 for free. The URL stays the source of truth: the form is keyed
// on the query string so „Изчисти", back/forward and shared links remount it and re-apply defaultChecked.
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
  const groupKeys = new Set(groups.map((g) => g.key));
  // Carry forward every current URL param that isn't a form control (search `q`, `authority`/`bidder`
  // scope, …) so the native GET submit doesn't erase it — the native form serialises only its own
  // fields. Group keys, `sort`, `cursor`, `page` are excluded (see preservedParamInputs).
  const preserved = preservedParamInputs(sp, groupKeys);
  // Count of currently-applied filters (from the loader/URL, not pending toggles), shown on the
  // submit button so the sticky bar doubles as a „N filters active" indicator.
  const appliedCount = groups.reduce((total, g) => total + g.selected.length, 0);
  // The form is keyed on the applied filter set so it remounts (re-applying defaultChecked) on „Изчисти",
  // back/forward and shared links — see the <Form> below.
  const formKey = filterFormKey(sp);
  // Accessibility (#228 review). Applying filters is one navigation triggered by „Търси"; the keyed
  // <Form> remounts on the new URL, so the button the visitor just activated is unmounted and keyboard
  // focus would silently fall to <body> (WCAG 2.4.3). We track the submit and, once the navigation
  // settles, return focus to the (remounted) „Търси" button and announce the update via a polite live
  // region. `busy` also drives `aria-busy` on the rail and a „Зареждане…" announcement.
  const navigation = useNavigation();
  const busy = navigation.state !== 'idle';
  const buttonRef = useRef<HTMLButtonElement>(null);
  const submittedRef = useRef(false);
  // Whether the visitor has toggled a control since the last apply — used to announce (once per editing
  // burst) that there are pending, not-yet-applied changes, since toggling is otherwise silent for a
  // screen-reader until „Търси" (WCAG 4.1.3).
  const dirtyRef = useRef(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (busy || !submittedRef.current) return;
    submittedRef.current = false;
    dirtyRef.current = false;
    // Only reclaim focus if it was actually lost to <body> by the remount — never steal it from wherever
    // the visitor may have moved in the meantime.
    if (document.activeElement === document.body || document.activeElement === null) {
      buttonRef.current?.focus();
    }
    setStatus('Резултатите са обновени.');
  }, [busy]);
  // Keep the floating apply pill from covering the site footer: as the footer scrolls into view, lift
  // the pill by however much the footer intrudes into the viewport, so it comes to rest just above it
  // (the footer constrains it). Enhancement only — with JS off the pill stays at its base offset.
  // Re-runs on `formKey` because the keyed <Form> remounts the pill (new node) on every filter apply;
  // an empty dep array would leave the listener writing to the old, detached div.
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = barRef.current;
    const footer = document.querySelector<HTMLElement>('.site-footer');
    if (!bar || !footer) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const overlap = Math.max(0, window.innerHeight - footer.getBoundingClientRect().top);
      bar.style.setProperty('--filter-bar-lift', `${overlap}px`);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [formKey]);
  // „Select all" only toggles its category's child checkboxes in the DOM; it never submits. The visitor
  // reviews the accumulated selection and presses „Търси" to apply it in one navigation.
  const onCategoryChange = (e: ChangeEvent<HTMLInputElement>, groupKey: string) => {
    e.stopPropagation();
    const input = e.currentTarget;
    const subgroup = input.closest('.filter-subgroup');

    subgroup
      ?.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name]')
      .forEach((member) => {
        if (member.name === groupKey) member.checked = input.checked;
      });
  };
  // Recompute a category's „Избери всички" checkbox from its members after a CHILD toggles. Without
  // this the select-all is uncontrolled (`defaultChecked`) and only its `indeterminate` is refreshed on
  // render, so after manually unchecking every child it stays visibly checked at zero selected until the
  // next submit/remount (#228 review). Runs via the form-level onChange below (child changes bubble).
  const syncSelectAll = (subgroup: Element, groupKey: string) => {
    const selectAll = subgroup.querySelector<HTMLInputElement>(
      ':scope > summary input[type="checkbox"]',
    );
    if (!selectAll) return;
    const members = Array.from(
      subgroup.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name]'),
    ).filter((m) => m.name === groupKey);
    const checkedCount = members.reduce((n, m) => (m.checked ? n + 1 : n), 0);
    selectAll.checked = members.length > 0 && checkedCount === members.length;
    selectAll.indeterminate = checkedCount > 0 && checkedCount < members.length;
  };
  // One delegated handler for every control in the form (changes bubble). Announces (once per editing
  // burst) that there are pending changes, and keeps each category's select-all in sync with its
  // children. The select-all itself has no `name`, so toggling it is skipped here — onCategoryChange
  // already drives its children, and those programmatic `.checked` writes don't fire change events.
  const onFormChange = (e: ChangeEvent<HTMLFormElement>) => {
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      setStatus('Има непроменени филтри. Натиснете „Търси", за да ги приложите.');
    }
    // `e.target` is typed as the form; narrow to the actual changed control. A named checkbox inside a
    // subgroup is a category child → resync its „Избери всички". The select-all itself has no name.
    const target: EventTarget = e.target;
    if (target instanceof HTMLInputElement && target.type === 'checkbox' && target.name) {
      const subgroup = target.closest('.filter-subgroup');
      if (subgroup) syncSelectAll(subgroup, target.name);
    }
  };
  // Progressive enhancement: drop empty-valued controls (the „Всички" radios submit `value=`/`eu=`) so
  // the applied URL stays canonical. Disabled controls are omitted from the native GET; with JS off this
  // never runs and the empty params are emitted but harmless (loaders treat empty as unset).
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    // Mark that this navigation came from „Търси" so the effect above can restore focus once it settles.
    submittedRef.current = true;
    const pruned: HTMLInputElement[] = [];
    for (const el of Array.from(e.currentTarget.elements)) {
      const input = el as HTMLInputElement;
      if (shouldPruneField(input, groupKeys)) {
        input.disabled = true;
        pruned.push(input);
      }
    }
    // Re-enable after submit. React Router reads FormData synchronously in this event, so a microtask
    // restores the controls without affecting the submitted query. Without this, a submit that does NOT
    // remount the form — e.g. re-submitting an unchanged selection, which only drops cursor/page and so
    // keeps the same `filterFormKey` — would leave the „Всички" radios permanently disabled, since the
    // imperative `disabled` was never in the JSX and no re-render resets it (#228 review).
    if (pruned.length) {
      queueMicrotask(() => {
        for (const input of pruned) input.disabled = false;
      });
    }
  };
  return (
    <aside className="filter-rail" aria-label="Филтри" aria-busy={busy || undefined}>
      {/* Polite status region: announces „Зареждане…" while a „Търси" navigation is in flight, that the
          results were updated once it settles, and (once per editing burst) that toggles are pending
          apply. Visually hidden — the button label already carries the visible applied-count. */}
      <p className="sr-only" role="status" aria-live="polite">
        {busy ? 'Зареждане на резултатите…' : status}
      </p>
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
      {/* Keyed on the applied filter set (cursor/page/sort excluded) so a new URL from clear, back/forward
          or a shared link remounts the form and re-applies `defaultChecked` — uncontrolled inputs would
          otherwise keep stale DOM state — while paging or re-sorting preserves open groups + focus. */}
      <Form method="get" key={formKey} onSubmit={onSubmit} onChange={onFormChange}>
        <input type="hidden" name="sort" value={sort} />
        {/* preservedParamInputs already carries every non-form URL param — the in-table search `q`
            (#204), the authority/bidder scope, etc. — so the native GET submit never erases them. */}
        {preserved.map(({ key, value }, i) => (
          <input type="hidden" name={key} value={value} key={`${key}-${i}`} />
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
                    defaultChecked={g.selected.length === 0}
                  />{' '}
                  {g.allLabel ?? 'Всички'}
                </label>
              )}
              {g.categories
                ? g.categories.map((category) => {
                    const { allSelected, someSelected } = categorySelectionState(
                      category.options.map((o) => o.value),
                      g.selected,
                    );

                    return (
                      <details className="filter-subgroup" key={category.key} open={someSelected}>
                        <summary>
                          <input
                            type="checkbox"
                            defaultChecked={allSelected}
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
                              defaultChecked={g.selected.includes(o.value)}
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
                        defaultChecked={g.selected.includes(o.value)}
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
        {/* One native submit applies the whole accumulated selection. Works with JS off; with JS on it
            still avoids a Worker request per toggle (issue #181). On desktop this is a floating pill
            fixed to the bottom of the viewport (see layout.css); the ref feeds the footer-lift effect. */}
        <div className="filter-apply-bar" ref={barRef}>
          <div className="filter-apply-inner">
            <button type="submit" className="filter-apply" ref={buttonRef}>
              Търси{appliedCount > 0 ? ` · ${fmtCount(appliedCount)}` : ''}
            </button>
            <p className="small muted filter-apply-links">
              <Link to={clearHref}>Изчисти филтрите</Link>
              {csvHref && (
                <>
                  {' · '}
                  <a href={csvHref}>Изтегли CSV</a>
                </>
              )}
            </p>
          </div>
        </div>
      </Form>
    </aside>
  );
}
