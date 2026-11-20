import { CPV_SECTORS, ENTITY_TYPES, PROCEDURE_GROUPS } from '@sigma/config';
import { AUTHORITY_TYPE_GROUPS, typeLabel } from '@sigma/db';
import type { FilterGroup } from '../components/FilterRail';
import { withParams } from './filters';

// A filter the URL carries but the rail does not show is the one a visitor cannot see or undo: /contracts?year=1999
// is a valid year, applied, with no option to tick because no contract has it — the list is empty and nothing on
// the page says why. And a value the list cannot apply (?year=abcd, ?value=x) is dropped, so the list silently
// means something else than the address. This module tells the two apart from what the loader actually applies,
// without a query of its own:
//   • applied but not among the options — shown as an active filter, with a link that removes only that value;
//   • not applied (unsupported, or past the cap) — named as left out, with a link that drops it from the address.
// Only the rail's own keys are read: any other query param is not a filter and is never shown as one.

export interface HiddenFilter {
  key: string;
  group: string;
  value: string;
  /** What to call the value; null when the list applies it but it is not a value the site knows. */
  label: string | null;
  removeHref: string;
}

export interface IgnoredFilter {
  key: string;
  group: string;
  removeHref: string;
}

export interface ActiveFilterState {
  groups: FilterGroup[];
  hidden: HiddenFilter[];
  ignored: IgnoredFilter[];
}

const SECTOR_LABELS = new Map(CPV_SECTORS.map((s) => [s.code, s.label]));
const PROCEDURE_LABELS = new Map<string, string>(PROCEDURE_GROUPS.map((g) => [g.key, g.label]));
const TYPE_GROUPS = new Set(AUTHORITY_TYPE_GROUPS);

/** The display name of an applied value, or null when the site has no name for it. */
function valueLabel(key: string, value: string): string | null {
  if (key === 'year') return value === 'unknown' ? 'Неизвестна' : value;
  if (key === 'sector') return SECTOR_LABELS.get(value) ?? null;
  if (key === 'procedure') return PROCEDURE_LABELS.get(value) ?? null;
  if (key === 'kind') return ENTITY_TYPES[value as keyof typeof ENTITY_TYPES] ?? null;
  if (key === 'type') return TYPE_GROUPS.has(value) ? (typeLabel(value) ?? value) : null;
  return null;
}

/** Every value the address gives a key, as getMulti reads it (repeated and comma-separated), before validation. */
function rawValues(sp: URLSearchParams, key: string): string[] {
  const all = sp
    .getAll(key)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  return Array.from(new Set(all));
}

function optionValues(group: FilterGroup): Set<string> {
  const values = new Set((group.options ?? []).map((o) => o.value));
  for (const category of group.categories ?? []) {
    for (const o of category.options) values.add(o.value);
  }
  return values;
}

/**
 * The rail groups as the list applies them, and what the address asks for that the rail would not show.
 * `groups` are the route's groups, whose `selected` is what the loader applies for a checkbox group (getMulti)
 * and the raw value for a radio group — which applies only when it is one of the group's options.
 */
export function activeFilterState(sp: URLSearchParams, groups: FilterGroup[]): ActiveFilterState {
  const hidden: HiddenFilter[] = [];
  const ignored: IgnoredFilter[] = [];
  const reset = { cursor: null, page: null };

  const out = groups.map((group): FilterGroup => {
    const known = optionValues(group);
    const raw =
      group.type === 'radio' ? sp.getAll(group.key).filter(Boolean) : rawValues(sp, group.key);
    const applied =
      group.type === 'radio'
        ? group.selected.slice(0, 1).filter((v) => known.has(v))
        : group.selected;

    if (raw.some((v) => !applied.includes(v))) {
      ignored.push({
        key: group.key,
        group: group.label,
        removeHref: withParams(sp, { [group.key]: applied, ...reset }),
      });
    }

    const missing = applied.filter((v) => !known.has(v));
    for (const value of missing) {
      hidden.push({
        key: group.key,
        group: group.label,
        value,
        label: valueLabel(group.key, value),
        // Only this value goes: the group's other values, the other filters and the search stay.
        removeHref: withParams(sp, { [group.key]: raw.filter((v) => v !== value), ...reset }),
      });
    }

    // A hidden applied value becomes a ticked option, so the rail shows it and unticking it removes it.
    const extra = missing.map((value) => ({
      value,
      label: valueLabel(group.key, value) ?? 'непозната стойност',
    }));
    return {
      ...group,
      selected: applied,
      ...(extra.length > 0
        ? group.categories
          ? {
              categories: [
                ...group.categories,
                { key: `${group.key}-selected`, label: 'Избрани извън списъка', options: extra },
              ],
            }
          : { options: [...(group.options ?? []), ...extra] }
        : {}),
    };
  });

  return { groups: out, hidden, ignored };
}
