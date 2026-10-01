import { describe, expect, it } from 'vitest';
import { isIndexedHost } from './indexing';

describe('isIndexedHost', () => {
  it('indexes the production site only', () => {
    expect(isIndexedHost('https://sigma.midt.bg/contracts?page=2')).toBe(true);
    expect(isIndexedHost(new URL('https://sigma.midt.bg/'))).toBe(true);
    expect(isIndexedHost(new Request('https://sigma.midt.bg/robots.txt'))).toBe(true);
  });

  it('keeps stage, dev, the workers.dev twins and local runs out of the index', () => {
    for (const url of [
      'https://sigma-stage.midt.bg/',
      'https://sigma-stage.cf-midt.workers.dev/',
      'https://sigma-dev.cf-midt.workers.dev/',
      'https://sigma.cf-midt.workers.dev/',
      'http://localhost:5173/',
      'https://sigma.midt.bg.example.test/',
    ])
      expect(isIndexedHost(url), url).toBe(false);
  });
});
