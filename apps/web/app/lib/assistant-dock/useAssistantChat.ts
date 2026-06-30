import { useEffect, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { classifyHttpError, networkError } from './errors';
import { clearTranscript, loadTranscript, saveTranscript, trimMessages } from './storage';

const ENDPOINT = '/assistant/chat';

// A user abort (useChat's stop) rejects the fetch. Narrow without asserting `Error` — a browser
// AbortError is a DOMException, not an Error instance.
const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';

// Pull a string `{ error }` out of an untrusted JSON body, or null.
const errorField = (body: unknown): string | null =>
  typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
    ? body.error
    : null;

/**
 * The fetch the transport uses: pass success responses through untouched, but turn a non-2xx response
 * (or a failed request) into a thrown Error carrying user-facing copy, so useChat surfaces it via
 * `error`. A user-initiated abort (stop) is re-thrown unchanged so it isn't shown as an error.
 */
export const classifyingFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(networkError());
  }
  if (response.ok) return response;

  // When the body is JSON, hand the server's `{ error }` to classifyHttpError; it surfaces that message
  // only for the user-facing statuses (503/413) and uses curated copy for the rest (400, 429, …).
  let serverMessage: string | null = null;
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    serverMessage = errorField(await response.json().catch(() => null));
  }
  throw new Error(classifyHttpError({ status: response.status, serverMessage }));
};

const transport = new DefaultChatTransport<UIMessage>({
  api: ENDPOINT,
  fetch: classifyingFetch,
  // Send only the most recent messages so the POST stays under the server's body/message caps.
  prepareSendMessagesRequest: ({ messages }) => ({ body: { messages: trimMessages(messages) } }),
});

/** useChat wired to /assistant/chat, with the transcript restored from / persisted to localStorage. */
export const useAssistantChat = (): ReturnType<typeof useChat> & { reset: () => void } => {
  // Throttle streamed token updates so the dock re-renders ~20×/s instead of once per token (the SDK's
  // intended knob for this); the final message still renders in full once the stream settles.
  const chat = useChat({ transport, experimental_throttle: 50 });
  const { messages, status, setMessages } = chat;

  // stop() is fire-and-forget, so a late settle can re-trigger persist/re-render after reset(); this flag
  // re-clears storage + transcript until the next send lifts it — sendMessage is the ONLY path that lifts it.
  const suppressPersist = useRef(false);

  // Restore the saved transcript once, after mount (localStorage is client-only → SSR-safe).
  useEffect(() => {
    const saved = loadTranscript();
    if (saved.length > 0) setMessages(saved);
  }, [setMessages]);

  // Persist after each settled turn (status 'ready'). The length guard is load-bearing: it stops the
  // empty initial state from clobbering stored history before the restore effect's setMessages commits.
  useEffect(() => {
    if (status !== 'ready' || messages.length === 0) return;
    if (suppressPersist.current) {
      // A superseded turn settled after reset() — a late flush can repopulate chat.messages, so re-clear
      // storage AND the transcript (else the old conversation visibly reappears). Next run early-returns.
      clearTranscript();
      setMessages([]);
      return;
    }
    saveTranscript(messages);
  }, [messages, status, setMessages]);

  // Start a fresh chat: abort any in-flight turn, drop the transcript (memory + storage), clear the error.
  const reset = () => {
    suppressPersist.current = true;
    chat.stop();
    chat.setMessages([]);
    chat.clearError();
    clearTranscript();
  };

  // Wrap sendMessage so a new turn lifts the post-reset suppression — only then may persistence resume.
  const sendMessage: typeof chat.sendMessage = (...args) => {
    suppressPersist.current = false;
    return chat.sendMessage(...args);
  };

  return { ...chat, sendMessage, reset };
};
