import { describe, expect, it } from 'vitest';
import { publicCache } from './cache';

describe('publicCache', () => {
  it('builds a public edge Cache-Control with the default stale-while-revalidate window', () => {
    expect(publicCache(120)).toBe('public, s-maxage=120, stale-while-revalidate=86400');
  });

  it('honours an explicit stale-while-revalidate override', () => {
    expect(publicCache(600, 30)).toBe('public, s-maxage=600, stale-while-revalidate=30');
  });
});
