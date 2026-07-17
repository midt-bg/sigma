import { describe, it, expect } from 'vitest';
import { assistantEnabled } from './enabled';

describe('assistantEnabled', () => {
  it('is ON only for explicit truthy strings (case / whitespace-insensitive)', () => {
    for (const on of ['true', 'TRUE', '1', 'on', ' On ', '\ttrue\n']) {
      expect(assistantEnabled(on)).toBe(true);
    }
  });

  it('fails dark for unset, empty, or any non-truthy value', () => {
    for (const off of [undefined, '', '  ', 'false', '0', 'off', 'no', 'enabled', 'yes']) {
      expect(assistantEnabled(off)).toBe(false);
    }
  });
});
