import { useEffect } from 'react';
import { setTurnstileMinter } from './turnstile-token';

// Mounts the invisible Cloudflare Turnstile widget and registers an execute-per-send token minter.
// No-op without a site key (dev/preview/staging that haven't provisioned Turnstile) — the server gate
// is a no-op there too, so the assistant works unchanged.
//
// Execution mode `'execute'`: the widget does nothing on render; we call `turnstile.execute()` before
// each send to mint a FRESH single-use token (reset() first, so a prior token never lingers). Browser-
// only + Cloudflare-hosted — verified manually on a preview with real/test keys, not in unit tests.

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const EXECUTE_TIMEOUT_MS = 8000;

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  execute(id: string): void;
  reset(id: string): void;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;
function loadTurnstileScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = SCRIPT_SRC;
    el.async = true;
    el.defer = true;
    el.onload = () => resolve();
    el.onerror = () => {
      scriptPromise = null; // allow a later retry
      reject(new Error('turnstile script failed to load'));
    };
    document.head.appendChild(el);
  });
  return scriptPromise;
}

export function useTurnstileGate(siteKey?: string | null): void {
  useEffect(() => {
    if (!siteKey || typeof window === 'undefined') return;

    let widgetId: string | null = null;
    let container: HTMLDivElement | null = null;
    let cancelled = false;

    // A single in-flight mint at a time (sends are sequential). `resolve`/`timer` are shared between the
    // widget's render callbacks (below) and the minter so either path settles the same pending promise.
    let resolve: ((token: string | null) => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (token: string | null) => {
      if (timer) clearTimeout(timer);
      timer = null;
      const r = resolve;
      resolve = null;
      r?.(token);
    };

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !window.turnstile) return;
        container = document.createElement('div');
        container.style.display = 'none';
        document.body.appendChild(container);
        widgetId = window.turnstile.render(container, {
          sitekey: siteKey,
          execution: 'execute',
          callback: (token: string) => settle(token),
          'error-callback': () => settle(null),
          'expired-callback': () => settle(null),
          'timeout-callback': () => settle(null),
        });

        setTurnstileMinter(
          () =>
            new Promise<string | null>((res) => {
              if (!widgetId || !window.turnstile || resolve) return res(null);
              resolve = res;
              timer = setTimeout(() => settle(null), EXECUTE_TIMEOUT_MS);
              try {
                window.turnstile.reset(widgetId);
                window.turnstile.execute(widgetId);
              } catch {
                settle(null);
              }
            }),
        );
      })
      .catch(() => {
        /* script blocked/offline → no gate; server gate is a no-op without a token anyway */
      });

    return () => {
      cancelled = true;
      setTurnstileMinter(null);
      settle(null);
      if (widgetId && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          /* already gone */
        }
      }
      container?.remove();
    };
  }, [siteKey]);
}
