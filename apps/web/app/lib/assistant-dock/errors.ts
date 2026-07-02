// Maps a non-2xx /assistant/chat response to a user-facing message.
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
