import type { VoiceInput } from './useVoiceInput';

// Maps assistant HTTP failures + voice states to user-facing Bulgarian copy (chat errors + voice status).
//
// For 503 and 413 the server already returns a user-facing message, so we show it as-is — the server is
// the source of truth. For statuses whose server body is internal (400 "invalid JSON"/"no messages"),
// English-only (429 "Too many assistant requests"), absent (network), or unexpected, we show curated copy
// instead, so no developer string leaks to the user. The classifier is pure; the transport wrapper
// (useAssistantChat) reads the Response and throws `new Error(message)` so useChat surfaces it via `error`.

export const ASSISTANT_ERROR_COPY = {
  rateLimited: 'Твърде много заявки. Опитайте отново след малко.',
  badRequest: 'Нещо се обърка със заявката. Опитайте отново.',
  unavailable: 'Асистентът временно не е достъпен. Опитайте отново след малко.',
  tooLarge: 'Разговорът стана твърде дълъг. Започнете нов разговор и опитайте отново.',
  unexpected: 'Възникна грешка. Опитайте отново.',
  network: 'Няма връзка със сървъра. Проверете връзката и опитайте отново.',
} as const;

export interface HttpErrorInput {
  status: number;
  /** The `{ error }` message from a JSON body, when the server sent one. */
  serverMessage?: string | null;
}

/** Classify a non-2xx response to a user-facing message (server side: routes/assistant.chat.tsx). */
export const classifyHttpError = ({ status, serverMessage }: HttpErrorInput): string => {
  switch (status) {
    case 429:
      return ASSISTANT_ERROR_COPY.rateLimited;
    case 503:
      return serverMessage?.trim() || ASSISTANT_ERROR_COPY.unavailable;
    case 413:
      return serverMessage?.trim() || ASSISTANT_ERROR_COPY.tooLarge;
    case 400:
      return ASSISTANT_ERROR_COPY.badRequest;
    default:
      return ASSISTANT_ERROR_COPY.unexpected;
  }
};

/** A failed fetch with no response — offline, DNS, aborted connection. */
export const networkError = (): string => ASSISTANT_ERROR_COPY.network;

// Voice transcription. Each error line ends by pointing back at the text box — the "never a dead mic"
// principle: voice failing must never trap a user who relies on it (accessibility).
export const VOICE_ERROR_COPY = {
  denied: 'Достъпът до микрофона е отказан. Можете да напишете въпроса си.',
  capture: 'Записът не бе възможен. Можете да напишете въпроса си.',
  unsupported: 'Гласовото въвеждане не се поддържа от този браузър. Напишете въпроса си.',
  noSpeech: 'Не разпознах реч. Опитайте отново или напишете въпроса си.',
  transcription:
    'Разпознаването на говор не бе успешно. Можете да напишете въпроса си, или опитайте отново.',
} as const;

export type VoiceErrorKind = keyof typeof VOICE_ERROR_COPY;

/** The status line to announce for the current voice state (empty when idle). Voice copy lives here. */
export const micStatusText = (voice: VoiceInput): string => {
  const state = voice.state;
  switch (state.status) {
    case 'requesting':
      return 'Изисква се достъп до микрофона…';
    case 'recording':
      return voice.endingSoon ? 'Остават 10 секунди…' : 'Записва се. Говорете сега.';
    case 'transcribing':
      return 'Записът приключи. Обработва се…';
    case 'error':
      return state.message;
    default:
      return '';
  }
};

/**
 * Classify a getUserMedia / MediaRecorder failure. A denied/blocked permission (NotAllowedError,
 * SecurityError) is distinct from a hardware/capture failure (no device, device in use, …); anything
 * else is treated as a capture error so the user always gets a clear next step.
 */
export function classifyMediaError(error: unknown): VoiceErrorKind {
  const name =
    typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  return name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'capture';
}
