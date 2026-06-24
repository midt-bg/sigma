import { useEffect, useId, useRef, useState } from 'react';
import { useFetcher, useNavigate } from 'react-router';
import { money } from '@sigma/shared';
import type { SearchHit } from '@sigma/api-contract';
import type { loader as suggestLoader } from '../routes/search.suggest';
import { useDebouncedValue } from '../hooks/useDebouncedValue';

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  authority: 'институция',
  company: 'компания',
  contract: 'договор',
};

// Below this length we don't query — single letters match almost everything and just add noise.
const MIN_QUERY = 2;
const DEBOUNCE_MS = 150;

interface SmartSearchProps {
  variant: 'hero' | 'drawer';
  defaultValue?: string;
  placeholder?: string;
  inputLabel?: string;
  submitLabel?: string;
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
  placeholder = 'Институция, компания или договор',
  inputLabel = 'Търсене',
  submitLabel = 'Намери',
  onNavigate,
  inputRef: externalInputRef,
}: SmartSearchProps) {
  const navigate = useNavigate();
  const fetcher = useFetcher<typeof suggestLoader>();
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

  // Fetch suggestions when the settled query is long enough; clear out below the threshold.
  useEffect(() => {
    if (debounced.length < MIN_QUERY) return;
    fetcher.load(`/search/suggest?q=${encodeURIComponent(debounced)}`);
    // fetcher identity is stable across renders; depending on it would re-fire needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const results = debounced.length >= MIN_QUERY ? fetcher.data : undefined;
  const groups = results?.groups.filter((g) => g.hits.length > 0) ?? [];
  const flatHits = groups.flatMap((g) => g.hits);
  const hasResults = flatHits.length > 0;
  // Trailing "see all" row is index === flatHits.length.
  const seeAllIndex = hasResults ? flatHits.length : -1;
  const optionCount = flatHits.length + (hasResults ? 1 : 0);

  const showList = open && debounced.length >= MIN_QUERY;
  const loading = fetcher.state === 'loading';

  // Any change to the option set invalidates the highlighted row.
  useEffect(() => setActiveIndex(-1), [debounced, fetcher.data]);

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
          placeholder={placeholder}
          aria-label={inputLabel}
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
          {submitLabel}
        </button>
      </form>

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
                  const meta = hit.ident || hit.subtitle;
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
                      <span className="smart-search-option-kind">{KIND_LABEL[hit.kind]}</span>
                      <span className="smart-search-option-body">
                        <span className="smart-search-option-title">{hit.title}</span>
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
