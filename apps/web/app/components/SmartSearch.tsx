import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { count, money, plural } from '@sigma/shared';
import type { SearchHit, SearchResults } from '@sigma/api-contract';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { personName } from '../lib/person-name';
import { kindLabel } from '../lib/search-labels';

// Below this length we don't query — single letters match almost everything and just add noise.
const MIN_QUERY = 2;
const DEBOUNCE_MS = 150;

interface SmartSearchProps {
  variant: 'hero' | 'drawer';
  defaultValue?: string;
  // Drawer wants to close itself once a suggestion navigates away.
  onNavigate?: () => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

// Accessible search combobox (WAI-ARIA combobox + listbox). Progressive enhancement: it renders a
// real GET form to /search, so with JS off (or before hydration) it submits exactly like the old
// static field. With JS, typing fetches ranked suggestions from /search/suggest and lets the user
// jump straight to an institution, company or contract — keyboard or pointer.
export function SmartSearch({
  variant,
  defaultValue = '',
  onNavigate,
  inputRef: externalInputRef,
}: SmartSearchProps) {
  const navigate = useNavigate();
  // `results: null` — the route refused or failed for this text (throttled, offline, an error).
  const [suggested, setSuggested] = useState<{ q: string; results: SearchResults | null } | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const localInputRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef ?? localInputRef;
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep the field in sync when the caller navigates between results pages and reopens the drawer.
  useEffect(() => {
    setQuery(defaultValue);
  }, [defaultValue]);

  const listboxId = useId();
  const optionId = (i: number) => `${listboxId}-opt-${i}`;

  const debounced = useDebouncedValue(query.trim(), DEBOUNCE_MS);

  // Fetch suggestions when the settled query is long enough, and only while the field is in use: a value
  // prefilled from the page's `?q=` asks nothing until the visitor focuses or types. The plain JSON route,
  // not a fetcher's `.data` twin: only the JSON response carries the edge-cache header, so a repeated
  // prefix is answered by the edge instead of a new search in D1.
  useEffect(() => {
    // A refused text is asked again once the field is used again (focus or typing).
    if (!open || debounced.length < MIN_QUERY) return;
    if (suggested?.q === debounced && suggested.results !== null) return;
    const controller = new AbortController();
    setLoading(true);
    fetch(`/search/suggest?q=${encodeURIComponent(debounced)}`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<SearchResults>) : null))
      // Throttled (429), offline or an error: no suggestions for this text, and the form still submits
      // to /search. An abort only means a newer text replaced it.
      .catch(() => null)
      .then((results) => {
        if (!controller.signal.aborted) setSuggested({ q: debounced, results });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      setLoading(false);
    };
    // `suggested` is read only to skip a repeat; depending on it would re-fire after every answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, open]);

  // While a new text is asked, the previous answer stays on screen; a refusal for the current text shows
  // no list at all — not a stale one, and not „no matches“.
  const refused = suggested?.q === debounced && suggested.results === null;
  const results = debounced.length >= MIN_QUERY ? (suggested?.results ?? undefined) : undefined;
  const groups = results?.groups.filter((g) => g.hits.length > 0) ?? [];
  const flatHits = groups.flatMap((g) => g.hits);
  const hasResults = flatHits.length > 0;
  // Trailing "see all" row is index === flatHits.length.
  const seeAllIndex = hasResults ? flatHits.length : -1;
  const optionCount = flatHits.length + (hasResults ? 1 : 0);

  const showList = open && debounced.length >= MIN_QUERY && !refused;

  // Any change to the option set invalidates the highlighted row, and so does closing the list, or
  // Enter on a reopened list would open a row the user no longer sees highlighted.
  useEffect(() => setActiveIndex(-1), [debounced, suggested, showList]);

  // Keep the row the arrows moved to in view: the list scrolls inside a capped box.
  const keyboardMove = useRef(false);
  useEffect(() => {
    if (!keyboardMove.current || activeIndex < 0) return;
    keyboardMove.current = false;
    document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: 'nearest' });
    // optionId is derived from a stable useId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex]);

  // Pointer-dismiss: closing on outside mousedown keeps it from fighting option clicks.
  useEffect(() => {
    if (!showList) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showList]);

  function goTo(href: string) {
    setOpen(false);
    onNavigate?.();
    navigate(href);
  }

  function selectIndex(i: number) {
    if (i === seeAllIndex) {
      goTo(`/search?q=${encodeURIComponent(query.trim())}`);
    } else if (i >= 0 && i < flatHits.length) {
      goTo(flatHits[i].href);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      if (showList) {
        e.preventDefault();
        // Swallow it so a surrounding drawer's Esc handler doesn't also fire: first Esc closes the
        // suggestions, a second Esc closes the drawer.
        e.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (!showList || optionCount === 0) return;
    keyboardMove.current = ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % optionCount);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => (i <= 0 ? optionCount - 1 : i - 1));
        break;
      case 'Enter':
        // Only intercept when a row is highlighted; otherwise let the form submit to /search.
        if (activeIndex >= 0) {
          e.preventDefault();
          selectIndex(activeIndex);
        }
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(optionCount - 1);
        break;
    }
  }

  // Flat option index as we walk groups in render order, so keyboard and DOM agree.
  let runningIndex = -1;

  return (
    <div className={`smart-search smart-search--${variant}`} ref={rootRef}>
      <form
        className="smart-search-form"
        role="search"
        action="/search"
        method="get"
        onSubmit={(e) => {
          if (!query.trim()) {
            e.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        <span className="smart-search-prompt" aria-hidden="true">
          ›
        </span>
        <input
          ref={inputRef}
          type="search"
          name="q"
          className="smart-search-input"
          value={query}
          placeholder="Институция, компания или договор"
          aria-label="Търсене"
          autoComplete="off"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="smart-search-submit">
          Намери
        </button>
      </form>

      <p className="sr-only" role="status">
        {showList && !loading
          ? hasResults
            ? `${count(flatHits.length)} ${plural(flatHits.length, 'предложение', 'предложения')}`
            : 'Няма съвпадения'
          : ''}
      </p>
      <div
        className={`smart-search-pop${showList ? ' is-open' : ''}`}
        // Hidden from AT until there's something to announce; inert when closed.
        hidden={!showList}
      >
        <ul className="smart-search-list" id={listboxId} role="listbox" aria-label="Предложения">
          {groups.map((g) => (
            <li key={g.kind} role="group" aria-label={g.label} className="smart-search-group">
              <p className="smart-search-group-label" aria-hidden="true">
                {g.label}
              </p>
              <ul className="smart-search-group-list" role="presentation">
                {g.hits.map((hit) => {
                  runningIndex += 1;
                  const i = runningIndex;
                  const baseMeta = hit.ident || hit.subtitle;
                  // A conflict-flagged company gets a compact trailing marker on its meta line.
                  const meta =
                    hit.kind === 'company' && hit.hasConflict
                      ? baseMeta
                        ? `${baseMeta} · свързани лица`
                        : 'свързани лица'
                      : baseMeta;
                  return (
                    <li
                      key={hit.slug + hit.title}
                      id={optionId(i)}
                      role="option"
                      aria-selected={activeIndex === i}
                      className={`smart-search-option${activeIndex === i ? ' is-active' : ''}`}
                      onMouseEnter={() => setActiveIndex(i)}
                      // Keep input focused so the click lands before blur closes the list.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => selectIndex(i)}
                    >
                      <span className="smart-search-option-kind">{kindLabel(hit)}</span>
                      <span className="smart-search-option-body">
                        <span className="smart-search-option-title">
                          {hit.kind === 'official' || hit.kind === 'person'
                            ? personName(hit.title)
                            : hit.title}
                        </span>
                        {meta && <span className="smart-search-option-meta">{meta}</span>}
                      </span>
                      {hit.amountEur != null && (
                        <span className="smart-search-option-amt">{money(hit.amountEur)}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}

          {hasResults && (
            <li
              id={optionId(seeAllIndex)}
              role="option"
              aria-selected={activeIndex === seeAllIndex}
              className={`smart-search-see-all${activeIndex === seeAllIndex ? ' is-active' : ''}`}
              onMouseEnter={() => setActiveIndex(seeAllIndex)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => selectIndex(seeAllIndex)}
            >
              Всички резултати за „{query.trim()}" →
            </li>
          )}

          {!hasResults && !loading && (
            <li className="smart-search-empty" role="presentation">
              Няма съвпадения. Пробвай с име, ЕИК или УНП.
            </li>
          )}
          {!hasResults && loading && (
            <li className="smart-search-empty" role="presentation" aria-live="polite">
              Търсене…
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
