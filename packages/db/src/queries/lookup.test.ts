import { describe, expect, it } from 'vitest';
import { lookup } from './lookup';

// Regression for the prototype-key class: a plain object literal inherits Object.prototype, so
// MAP['__proto__'] / MAP['toString'] / … resolve truthy inherited members, defeating callers'
// `?? default` / `if (MAP[key])` guards (→ uncaught throws, or a silent empty CSV export).
// `lookup()` removes the prototype chain so those keys are `undefined` and the guards fall back.
describe('lookup — null-prototype map safe for untrusted keys', () => {
  const m = lookup({ 'value-desc': { dir: 'desc' }, won: { dir: 'asc' } });
  const at = (k: string): unknown => (m as Record<string, unknown>)[k];

  it('returns own values for real keys', () => {
    expect(m['value-desc']).toEqual({ dir: 'desc' });
    expect(m.won).toEqual({ dir: 'asc' });
  });

  it('returns undefined for reserved prototype keys (no chain to walk)', () => {
    for (const key of [
      '__proto__',
      'toString',
      'valueOf',
      'constructor',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      '__defineGetter__',
    ]) {
      expect(at(key)).toBeUndefined();
    }
  });

  it('returns undefined for unknown keys', () => {
    expect(at('nope')).toBeUndefined();
  });

  it('keeps Object.values working (feeds allowedSortCols)', () => {
    expect(Object.values(m)).toEqual([{ dir: 'desc' }, { dir: 'asc' }]);
  });
});
