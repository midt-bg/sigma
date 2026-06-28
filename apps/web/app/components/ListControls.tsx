import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Form, Link, useNavigation, useSubmit } from 'react-router';
import { hasSearchableTerms } from '@sigma/shared';
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
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);

  // Navigate to the search href. `replace` for live typing (don't trace every keystroke in history),
  // push for deliberate actions (Enter, clear). Building params from searchHref — not submitting the
  // raw form — is what guarantees canonical order + cursor/page reset on the JS path.
  const go = (q: string, replace: boolean) =>
    submit(new URLSearchParams(searchHref(base, q)), { method: 'get', replace });

  // Adopt the URL's q on EXTERNAL navigation only (back/forward, links, filter changes). Never touch
  // the field while it's focused — the user is mid-edit, and a stale loader landing late would
  // otherwise revert keystrokes typed since (React Router aborts superseded GETs, so our own live
  // submits can't land out of order; this guard only covers interleaved external navigation).
  useEffect(() => {
    if (urlQ === value) return;
    if (inputRef.current && inputRef.current === document.activeElement) return;
    setValue(urlQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resync keys off the URL's q only
  }, [urlQ]);

  // Live submit once typing settles. The guards suppress the mount fire, the echo of our own
  // navigation, and submitting mid-IME-composition (so a Cyrillic word commits whole, not „мо" for
  // „мост"). Depends on `debounced` only — `base` gets a new identity every navigation.
  useEffect(() => {
    if (composingRef.current) return;
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
        ref={inputRef}
        id={labelId}
        type="search"
        name="q"
        value={value}
        autoComplete="off"
        placeholder="Търси в таблицата…"
        onChange={(e) => setValue(e.target.value)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(e) => {
          // Re-arm the debounce with the committed word; setting value here (rather than relying on a
          // trailing input event) makes us robust to compositionend/input ordering across browsers.
          composingRef.current = false;
          setValue(e.currentTarget.value);
        }}
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
      {/* A query that's only punctuation or a single char yields no FTS terms — the backend ignores
          it and shows the full list. Tell the user so the box/URL don't look like an active search. */}
      {value.trim() !== '' && !hasSearchableTerms(value) && (
        <p role="status" className="muted small table-search-hint">
          Въведете поне 2 знака; пунктуацията се пренебрегва
        </p>
      )}
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
