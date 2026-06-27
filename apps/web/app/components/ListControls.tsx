import { useEffect, useId, useState, type ReactNode } from 'react';
import { Form, Link, useNavigation, useSubmit } from 'react-router';
import { searchHref, sortHref } from '../lib/filters';
import { useDebouncedValue } from '../hooks/useDebouncedValue';

export interface SortOption {
  value: string;
  label: string;
}

const SEARCH_DEBOUNCE_MS = 300;

// In-table search. A real `<Form method="get">` so it filters the list without JS (plain Enter /
// the visible submit), progressively enhanced with a debounced live submit via `useSubmit`. Setting
// `q` keeps every other filter/sort and resets paging (see lib/filters.searchHref); clearing drops
// `q` only. `searchLabel` names the search landmark so it's distinct from the site-wide header search.
function TableSearch({ base, searchLabel }: { base: URLSearchParams; searchLabel: string }) {
  const submit = useSubmit();
  const urlQ = base.get('q') ?? '';
  const [value, setValue] = useState(urlQ);
  const debounced = useDebouncedValue(value, SEARCH_DEBOUNCE_MS);
  const labelId = useId();

  // Navigate to the search href. `replace` for live typing (don't trace every keystroke in history),
  // push for deliberate actions (Enter, clear). Building params from searchHref — not submitting the
  // raw form — is what guarantees canonical order + cursor/page reset on the JS path.
  const go = (q: string, replace: boolean) =>
    submit(new URLSearchParams(searchHref(base, q)), { method: 'get', replace });

  // Adopt the URL's q on EXTERNAL navigation only (back/forward, links, filter changes); never clobber
  // what the user is typing. Skip when already in sync or when this is the echo of our own submit.
  useEffect(() => {
    if (urlQ === value || urlQ === debounced.trim()) return;
    setValue(urlQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resync keys off the URL's q only
  }, [urlQ]);

  // Live submit once typing settles. The guard suppresses the mount fire and the echo of our own
  // navigation, breaking the type→submit→type loop. Depends on `debounced` only — `base` gets a new
  // identity every navigation and would otherwise re-fire this.
  useEffect(() => {
    if (debounced.trim() === urlQ.trim()) return;
    go(debounced, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when the settled value changes
  }, [debounced]);

  return (
    <Form
      method="get"
      role="search"
      aria-label={searchLabel}
      className="table-search"
      onSubmit={(e) => {
        e.preventDefault();
        go(value, false);
      }}
    >
      <label htmlFor={labelId} className="sr-only">
        Търси в таблицата
      </label>
      <input
        id={labelId}
        type="search"
        name="q"
        value={value}
        autoComplete="off"
        placeholder="Търси в таблицата…"
        onChange={(e) => setValue(e.target.value)}
      />
      {/* No-JS preservation: carry every active param except q/cursor/page. Omitting cursor/page
          means a native GET drops them, so a search resets to page 1 without JS too. */}
      {Array.from(base.entries())
        .filter(([key]) => key !== 'q' && key !== 'cursor' && key !== 'page')
        .map(([key, val], i) => (
          <input key={`${key}-${i}-${val}`} type="hidden" name={key} value={val} />
        ))}
      {/* The clear affordance is the input's native `type="search"` cancel button (styled below);
          clicking it empties the field, and the onChange→debounced submit drops `q` from the URL. */}
      <noscript>
        <button type="submit">Търси</button>
      </noscript>
    </Form>
  );
}

// The strip above a list: an optional in-table search row, then a result-count line on the left and
// sort links on the right. Sort links keep the current filters and reset paging (see lib/filters).
export function ListControls({
  count,
  base,
  sorts,
  activeSort,
  searchLabel,
}: {
  count: ReactNode;
  base: URLSearchParams;
  sorts: SortOption[];
  activeSort: string;
  searchLabel?: string;
}) {
  // Reflect in-flight navigation/revalidation so slow networks get quiet feedback.
  const busy = useNavigation().state !== 'idle';
  return (
    <div className="list-controls-bar">
      {searchLabel && <TableSearch base={base} searchLabel={searchLabel} />}
      <div className="list-controls" aria-busy={busy || undefined}>
        <p className="muted small" aria-live="polite">
          {count}
          {busy ? <span className="muted small"> · Зарежда…</span> : null}
        </p>
        <p className="muted small">
          Подреди:{' '}
          {sorts.map((s, i) => (
            <span key={s.value}>
              {i > 0 ? ' · ' : ''}
              {s.value === activeSort ? (
                <Link to={sortHref(base, s.value)} aria-current="true">
                  <strong>{s.label}</strong>
                </Link>
              ) : (
                <Link to={sortHref(base, s.value)}>{s.label}</Link>
              )}
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}
