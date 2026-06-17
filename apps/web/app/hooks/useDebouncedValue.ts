import { useEffect, useState } from 'react';

// Returns a copy of `value` that only updates after it has stayed unchanged for `delay` ms. Used to
// throttle live-search requests: the input updates synchronously for the user, but the fetch keyed
// off the debounced value only fires once typing settles.
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);

  return debounced;
}
