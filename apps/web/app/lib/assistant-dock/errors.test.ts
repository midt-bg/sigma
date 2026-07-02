import { describe, expect, it } from 'vitest';
import { ASSISTANT_ERROR_COPY, classifyHttpError, networkError } from './errors';

describe('classifyHttpError', () => {
  it('maps 429 to the rate-limited copy', () => {
    expect(classifyHttpError({ status: 429 })).toBe(ASSISTANT_ERROR_COPY.rateLimited);
  });

  it('shows the server message for 503', () => {
    expect(classifyHttpError({ status: 503, serverMessage: 'Сървърна бележка' })).toBe(
      'Сървърна бележка',
    );
  });

  it('falls back to curated copy for 503 with no server message', () => {
    expect(classifyHttpError({ status: 503 })).toBe(ASSISTANT_ERROR_COPY.unavailable);
  });

  it('shows the server message for 413', () => {
    expect(classifyHttpError({ status: 413, serverMessage: 'историята е твърде голяма' })).toBe(
      'историята е твърде голяма',
    );
  });

  it('falls back to curated copy for 413 with no server message', () => {
    expect(classifyHttpError({ status: 413 })).toBe(ASSISTANT_ERROR_COPY.tooLarge);
  });

  it('does not leak the internal 400 body to the user', () => {
    expect(classifyHttpError({ status: 400, serverMessage: 'invalid JSON' })).toBe(
      ASSISTANT_ERROR_COPY.badRequest,
    );
  });

  it('maps an unexpected status to the generic copy', () => {
    expect(classifyHttpError({ status: 500 })).toBe(ASSISTANT_ERROR_COPY.unexpected);
  });
});

describe('networkError', () => {
  it('returns the offline copy', () => {
    expect(networkError()).toBe(ASSISTANT_ERROR_COPY.network);
  });
});
