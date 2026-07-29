import { useEffect, useRef, useState } from 'react';
import { useChat, type UseChatHelpers } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { classifyHttpError, networkError } from './errors';
import { nextTurnstileToken, withTurnstileHeader } from './turnstile-token';
import { isPhasePart, type AssistantPhase } from '../assistant-contract/stream';
import { condenseForPost } from './condense';
import {
  clearTranscript,
  loadConversationId,
  loadTranscript,
  resetConversationId,
  saveTranscript,
  trimMessages,
} from './storage';

const ENDPOINT = '/assistant/chat';

// A user abort (useChat's stop) rejects the fetch. Narrow without asserting `Error` — a browser
// AbortError is a DOMException, not an Error instance.
const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';

// Upper bound for a single chat request. Streaming answers take seconds; 90s comfortably covers a slow
// model turn while still rescuing the UI from a silently-dropped connection.
const STREAM_TIMEOUT_MS = 90_000;

// Combine the user-abort signal with a request timeout. Uses the platform AbortSignal.timeout/any when
// present; falls back to a manual AbortController for older browsers (AbortSignal.any is Chrome 116 /
// Firefox 124 / Safari 17.4) so the call never throws TypeError and the timeout guard isn't silently
// dead. A timeout aborts with a TimeoutError (not AbortError), so it surfaces the network-error path,
// while a propagated user stop() stays a silent AbortError.
function requestSignal(userSignal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function' && typeof AbortSignal.any === 'function') {
    const timeout = AbortSignal.timeout(timeoutMs);
    return userSignal ? AbortSignal.any([userSignal, timeout]) : timeout;
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    timeoutMs,
  );
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  if (userSignal) {
    if (userSignal.aborted) controller.abort(userSignal.reason);
    else
      userSignal.addEventListener('abort', () => controller.abort(userSignal.reason), {
        once: true,
      });
  }
  return controller.signal;
}

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
  // Attach a fresh Turnstile token when the gate is active; a no-op (unchanged init) otherwise.
  const token = await nextTurnstileToken();
  const baseInit = token ? { ...init, headers: withTurnstileHeader(init?.headers, token) } : init;
  // Bound the request so a wedged/half-open socket can't leave the dock stuck on a spinner forever
  // (combined with the user-abort signal; falls back to a manual controller on older browsers).
  const signal = requestSignal(baseInit?.signal, STREAM_TIMEOUT_MS);
  const requestInit = { ...baseInit, signal };
  let response: Response;
  try {
    response = await fetch(input, requestInit);
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

/**
 * Shape the outbound POST body: condense old turns into one recap message so their meaning survives
 * (condense.ts), then apply the count/byte trim as the hard backstop against the server's caps — a
 * pathological transcript can still never 413. Exported for tests.
 */
export const prepareChatBody = (
  messages: UIMessage[],
  conversationId: string,
): { messages: UIMessage[]; conversationId: string } => ({
  messages: trimMessages(condenseForPost(messages)),
  conversationId,
});

const transport = new DefaultChatTransport<UIMessage>({
  api: ENDPOINT,
  fetch: classifyingFetch,
  // Read the conversation id at send time (minted lazily on first send) so every POST in the thread
  // carries the same id — the server binds its per-message signatures to it (spec §9.3).
  prepareSendMessagesRequest: ({ messages }) => ({
    body: prepareChatBody(messages, loadConversationId()),
  }),
});

/** useChat wired to /assistant/chat, with the transcript restored from / persisted to localStorage. */
export const useAssistantChat = (): UseChatHelpers<UIMessage> & {
  phase: AssistantPhase | null;
  reset: () => void;
  aborted: boolean;
} => {
  // The ephemeral turn phase, delivered as a transient data part via onData (never in messages).
  const [phase, setPhase] = useState<AssistantPhase | null>(null);
  // The SDK exposes no abort signal: after stop() the status settles to 'ready' exactly like a
  // natural finish (classifyingFetch swallows the AbortError on purpose). Minted here, where the
  // user acts, so the transcript can announce „прекъснат" instead of a false „готов".
  const [aborted, setAborted] = useState(false);
  // Throttle streamed token updates so the dock re-renders ~20×/s instead of once per token (the SDK's
  // intended knob for this); the final message still renders in full once the stream settles.
  const chat = useChat({
    transport,
    experimental_throttle: 50,
    onData: (part) => {
      if (isPhasePart(part)) setPhase(part.data.phase);
    },
  });
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

  // The phase line is ephemeral: clear it when the turn settles, and on submit so a stale phase from
  // the previous turn can't flash before the first onData of the next one arrives.
  useEffect(() => {
    if (status === 'submitted' || status === 'ready' || status === 'error') setPhase(null);
  }, [status]);

  // A new turn supersedes the aborted marker. Keyed on status (not on the stop/send wrappers) so
  // it also covers turns started via regenerate, which is passed through unwrapped.
  useEffect(() => {
    if (status === 'submitted' || status === 'streaming') setAborted(false);
  }, [status]);

  // Record the user's stop of a busy turn before delegating; stop while idle is a no-op marker-wise.
  const stop: typeof chat.stop = (...args) => {
    if (status === 'submitted' || status === 'streaming') setAborted(true);
    return chat.stop(...args);
  };

  // Start a fresh chat: abort any in-flight turn, drop the transcript (memory + storage), clear the error.
  const reset = () => {
    suppressPersist.current = true;
    chat.stop(); // raw SDK stop: a reset is not a user "stop", so it must not mark the turn aborted
    chat.setMessages([]);
    chat.clearError();
    clearTranscript();
    resetConversationId(); // a fresh chat is a fresh conversation — new id for the next turn's signatures
    setAborted(false);
  };

  // Wrap sendMessage so a new turn lifts the post-reset suppression — only then may persistence resume.
  const sendMessage: typeof chat.sendMessage = (...args) => {
    suppressPersist.current = false;
    return chat.sendMessage(...args);
  };

  return { ...chat, sendMessage, stop, reset, phase, aborted };
};
