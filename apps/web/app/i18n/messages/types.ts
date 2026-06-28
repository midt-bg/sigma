import type { bg } from './bg';

// Deep-widen the Bulgarian reference catalog's string literals to `string`, preserving the key
// structure. The English catalog is typed as `Messages`, so it must mirror every key in `bg` (a
// missing or extra key is a compile error) while holding its own string values.
type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

export type Messages = Widen<typeof bg>;
