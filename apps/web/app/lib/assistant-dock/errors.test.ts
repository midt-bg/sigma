import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_ERROR_COPY,
  VOICE_ERROR_COPY,
  classifyHttpError,
  classifyMediaError,
  micStatusText,
  networkError,
} from './errors';
import type { VoiceInput, VoiceState } from './useVoiceInput';

const voice = (state: VoiceState, over: Partial<VoiceInput> = {}): VoiceInput => ({
  state,
  startedAt: null,
  endingSoon: false,
  start: () => {},
  stop: () => {},
  ...over,
});

describe('micStatusText', () => {
  it('recording, not ending soon → the speak-now line', () => {
    expect(micStatusText(voice({ status: 'recording' }, { endingSoon: false }))).toBe(
      'Записва се. Говорете сега.',
    );
  });

  it('recording, ending soon → the ten-seconds-left warning', () => {
    expect(micStatusText(voice({ status: 'recording' }, { endingSoon: true }))).toBe(
      'Остават 10 секунди…',
    );
  });

  it('requesting → the permission-prompt line', () => {
    expect(micStatusText(voice({ status: 'requesting' }))).toBe('Изисква се достъп до микрофона…');
  });

  it('error → the error message verbatim', () => {
    expect(micStatusText(voice({ status: 'error', kind: 'denied', message: 'няма достъп' }))).toBe(
      'няма достъп',
    );
  });

  it('idle → empty (nothing to announce)', () => {
    expect(micStatusText(voice({ status: 'idle' }))).toBe('');
  });
});

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

describe('classifyMediaError', () => {
  it('maps a denied mic permission (NotAllowedError) to the denied copy', () => {
    expect(classifyMediaError({ name: 'NotAllowedError' })).toBe('denied');
  });

  it('maps a blocked secure-context (SecurityError) to the denied copy', () => {
    expect(classifyMediaError({ name: 'SecurityError' })).toBe('denied');
  });

  it('maps a missing device (NotFoundError) to the capture copy', () => {
    expect(classifyMediaError({ name: 'NotFoundError' })).toBe('capture');
  });

  it('maps an unknown / non-error value to the capture copy', () => {
    expect(classifyMediaError(null)).toBe('capture');
  });
});

describe('VOICE_ERROR_COPY', () => {
  it('every error line points the user back to typing (never a dead mic)', () => {
    expect(VOICE_ERROR_COPY.denied).toContain('напишете');
    expect(VOICE_ERROR_COPY.capture).toContain('напишете');
    expect(VOICE_ERROR_COPY.unsupported).toContain('Напишете');
    expect(VOICE_ERROR_COPY.transcription).toContain('напишете');
  });
});
