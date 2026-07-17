import { describe, expect, it } from 'vitest';
import { APICallError, RetryError } from 'ai';
import {
  GATEWAY_OVERLOADED_MESSAGE,
  STREAM_ERROR_MESSAGE,
  classifyStreamError,
  isGatewayRateLimit,
} from './stream-errors';

// Fixture builders — real SDK error instances, because isInstance() checks the SDK's Symbol.for
// marker and a plain object shaped like an APICallError must NOT classify (spoof-resistance).
const makeApiCallError = (statusCode?: number) =>
  new APICallError({
    message: `gateway responded ${statusCode ?? 'without status'}`,
    url: 'https://gateway.ai.cloudflare.com/v1/acct/sigma/openai/chat/completions',
    requestBodyValues: {},
    statusCode,
  });

const makeRetryError = (
  reason: 'maxRetriesExceeded' | 'errorNotRetryable' | 'abort',
  errors: unknown[],
) => new RetryError({ message: `retries failed (${reason})`, reason, errors });

describe('isGatewayRateLimit', () => {
  describe('recognizes a gateway 429', () => {
    it('matches a bare APICallError with statusCode 429', () => {
      expect(isGatewayRateLimit(makeApiCallError(429))).toBe(true);
    });

    it('matches a RetryError(maxRetriesExceeded) whose lastError is a 429', () => {
      const retry = makeRetryError('maxRetriesExceeded', [makeApiCallError(429)]);
      expect(isGatewayRateLimit(retry)).toBe(true);
    });

    it('matches a RetryError where only an earlier attempt was a 429', () => {
      // First attempt hit the cap, the retry then died on a network-shaped error: still overload.
      const retry = makeRetryError('maxRetriesExceeded', [
        makeApiCallError(429),
        new Error('network reset'),
      ]);
      expect(isGatewayRateLimit(retry)).toBe(true);
    });

    it('matches a RetryError(errorNotRetryable) wrapping a 429', () => {
      const retry = makeRetryError('errorNotRetryable', [makeApiCallError(429)]);
      expect(isGatewayRateLimit(retry)).toBe(true);
    });
  });

  describe('rejects everything that is not a gateway 429', () => {
    it('rejects an APICallError with statusCode 500', () => {
      expect(isGatewayRateLimit(makeApiCallError(500))).toBe(false);
    });

    it('rejects an APICallError with statusCode 503', () => {
      expect(isGatewayRateLimit(makeApiCallError(503))).toBe(false);
    });

    it('rejects an APICallError without a statusCode', () => {
      expect(isGatewayRateLimit(makeApiCallError(undefined))).toBe(false);
    });

    it('rejects a RetryError wrapping only non-429 errors', () => {
      const retry = makeRetryError('maxRetriesExceeded', [
        makeApiCallError(500),
        makeApiCallError(503),
      ]);
      expect(isGatewayRateLimit(retry)).toBe(false);
    });

    it('rejects a RetryError with an empty errors array', () => {
      expect(isGatewayRateLimit(makeRetryError('maxRetriesExceeded', []))).toBe(false);
    });

    it('rejects a RetryError(abort) wrapping an abort error — a cancelled turn is not overload', () => {
      const abort = new DOMException('The operation was aborted.', 'AbortError');
      expect(isGatewayRateLimit(makeRetryError('abort', [abort]))).toBe(false);
    });

    it('rejects a plain Error', () => {
      expect(isGatewayRateLimit(new Error('boom'))).toBe(false);
    });

    it('rejects undefined', () => {
      expect(isGatewayRateLimit(undefined)).toBe(false);
    });

    it('rejects null', () => {
      expect(isGatewayRateLimit(null)).toBe(false);
    });

    it('rejects a bare string', () => {
      expect(isGatewayRateLimit('429')).toBe(false);
    });

    it('rejects a plain object spoofing the APICallError shape', () => {
      expect(isGatewayRateLimit({ statusCode: 429, isRetryable: true })).toBe(false);
    });
  });
});

describe('classifyStreamError', () => {
  describe('maps gateway 429s to the overload message', () => {
    it('bare 429 → „Системата е натоварена…"', () => {
      expect(classifyStreamError(makeApiCallError(429))).toBe(GATEWAY_OVERLOADED_MESSAGE);
    });

    it('RetryError-wrapped 429 → „Системата е натоварена…"', () => {
      const retry = makeRetryError('maxRetriesExceeded', [makeApiCallError(429)]);
      expect(classifyStreamError(retry)).toBe(GATEWAY_OVERLOADED_MESSAGE);
    });
  });

  describe('maps everything else to the generic mid-stream message', () => {
    it('APICallError 500 → generic message', () => {
      expect(classifyStreamError(makeApiCallError(500))).toBe(STREAM_ERROR_MESSAGE);
    });

    it('RetryError wrapping only non-429s → generic message', () => {
      const retry = makeRetryError('maxRetriesExceeded', [makeApiCallError(500)]);
      expect(classifyStreamError(retry)).toBe(STREAM_ERROR_MESSAGE);
    });

    it('plain Error → generic message', () => {
      expect(classifyStreamError(new Error('boom'))).toBe(STREAM_ERROR_MESSAGE);
    });

    it('undefined → generic message', () => {
      expect(classifyStreamError(undefined)).toBe(STREAM_ERROR_MESSAGE);
    });

    it('spoofed {statusCode: 429} object → generic message', () => {
      expect(classifyStreamError({ statusCode: 429 })).toBe(STREAM_ERROR_MESSAGE);
    });
  });
});

describe('user-facing copy', () => {
  it('overload message carries the exact spec wording (ai-assistant-agent-team.md §3)', () => {
    expect(GATEWAY_OVERLOADED_MESSAGE).toBe('Системата е натоварена, опитай пак след малко.');
  });

  it('generic message carries the exact wording from the contracts error matrix', () => {
    expect(STREAM_ERROR_MESSAGE).toBe(
      'Асистентът временно не е достъпен. Опитай отново след малко.',
    );
  });
});
