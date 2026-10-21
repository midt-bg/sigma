import { afterEach, describe, expect, it, vi } from 'vitest';
import { sigmaVersion } from './meta';

describe('sigmaVersion', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is the commit a deploy stamped into the build, and empty outside one', () => {
    expect(sigmaVersion()).toBe('');
    vi.stubGlobal('__SIGMA_VERSION__', 'a127724d0f1e');
    expect(sigmaVersion()).toBe('a127724d0f1e');
  });
});
