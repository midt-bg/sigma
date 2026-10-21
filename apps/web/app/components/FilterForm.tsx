import { useEffect, useRef, type ReactNode } from 'react';
import { Form, useLocation, useSubmit } from 'react-router';

/**
 * The select filters of the visualisation pages (/flows, /trends, /map, /competition, /network).
 *
 * - A choice picked with the mouse, or confirmed with Enter in the opened list, applies at once. Arrow
 *   keys and type-ahead on a closed select only move the choice: it applies on Enter or when focus
 *   leaves the select, so a keyboard user can look through the options without a reload per step.
 * - `values` are the choices the URL stands for. The selects are uncontrolled, so after Back/Forward
 *   or an in-page link they would keep the last pick; they are set back to `values` on every URL change.
 */
export function FilterForm({
  label,
  values,
  children,
}: {
  label: string;
  values: Record<string, string>;
  children: ReactNode;
}) {
  const submit = useSubmit();
  const { search } = useLocation();
  const form = useRef<HTMLFormElement>(null);
  const browsing = useRef(false); // the last key moved the choice without committing it
  const pending = useRef(false); // a choice moved by keys, not yet applied

  useEffect(() => {
    pending.current = false;
    for (const [name, value] of Object.entries(values)) {
      const el = form.current?.elements.namedItem(name);
      if (el instanceof HTMLSelectElement) el.value = value;
    }
    // `values` is derived from the URL; re-sync only when the URL changes.
  }, [search]);

  const apply = (f: HTMLFormElement) => {
    pending.current = false;
    void submit(f);
  };

  return (
    <Form
      ref={form}
      method="get"
      className="flow-controls"
      aria-label={label}
      onPointerDown={() => {
        browsing.current = false;
      }}
      onKeyDown={(e) => {
        if (!(e.target instanceof HTMLSelectElement)) return;
        if (e.key === 'Enter') {
          browsing.current = false;
          if (pending.current) {
            e.preventDefault();
            apply(e.currentTarget);
          }
        } else if (e.key !== 'Tab' && e.key !== 'Shift' && e.key !== 'Escape') {
          browsing.current = true;
        }
      }}
      onChange={(e) => {
        if (browsing.current) pending.current = true;
        else apply(e.currentTarget);
      }}
      onBlur={(e) => {
        if (pending.current && e.target instanceof HTMLSelectElement) apply(e.currentTarget);
      }}
    >
      {children}
      <noscript>
        <button type="submit">Покажи</button>
      </noscript>
    </Form>
  );
}

/** One wording for the funding filter on every page that has it. */
export function FundingSelect({ value }: { value: string }) {
  return (
    <label>
      Финансиране:
      <select name="funding" defaultValue={value}>
        <option value="">Всички</option>
        <option value="eu">Само с финансиране от ЕС</option>
        <option value="national">Само без финансиране от ЕС</option>
      </select>
    </label>
  );
}
