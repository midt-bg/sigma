import { describe, expect, it } from 'vitest';
import { authorizeSeed, bearerToken, timingSafeEqual } from './seed-endpoint';

describe('bearerToken', () => {
  it('extracts the credential from a well-formed header', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
  });

  it('is case-insensitive on the scheme and tolerates extra whitespace', () => {
    expect(bearerToken('  bearer   tok-9  ')).toBe('tok-9');
  });

  it('returns empty string for a null header', () => {
    expect(bearerToken(null)).toBe('');
  });

  it('returns empty string for a non-Bearer scheme', () => {
    expect(bearerToken('Basic abc123')).toBe('');
  });

  it('returns empty string when the scheme has no credential', () => {
    expect(bearerToken('Bearer ')).toBe('');
  });
});

describe('timingSafeEqual', () => {
  it('is true for identical strings', () => {
    expect(timingSafeEqual('s3cr3t-token', 's3cr3t-token')).toBe(true);
  });

  it('is false when only the last byte differs', () => {
    expect(timingSafeEqual('s3cr3t-tokenA', 's3cr3t-tokenB')).toBe(false);
  });

  it('is false for a matching prefix of different length', () => {
    expect(timingSafeEqual('token', 'token-extra')).toBe(false);
  });

  it('is true for two empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('handles multibyte (Cyrillic) tokens by byte comparison', () => {
    expect(timingSafeEqual('токен', 'токен')).toBe(true);
    expect(timingSafeEqual('токен', 'токеи')).toBe(false);
  });
});

describe('authorizeSeed', () => {
  it('is unconfigured when no token is provisioned', () => {
    expect(authorizeSeed(undefined, 'anything')).toEqual({ status: 'unconfigured' });
  });

  it('is unconfigured for an empty configured token', () => {
    expect(authorizeSeed('', 'anything')).toEqual({ status: 'unconfigured' });
  });

  it('is forbidden when the presented bearer is absent', () => {
    expect(authorizeSeed('the-real-token', '')).toEqual({ status: 'forbidden' });
  });

  it('is forbidden when the presented bearer is wrong', () => {
    expect(authorizeSeed('the-real-token', 'the-wrong-token')).toEqual({ status: 'forbidden' });
  });

  it('is ok when the presented bearer matches', () => {
    expect(authorizeSeed('the-real-token', 'the-real-token')).toEqual({ status: 'ok' });
  });
});
