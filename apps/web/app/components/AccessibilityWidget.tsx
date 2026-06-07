import { useEffect } from 'react';

type AccessibilityOptions = {
  parentSelector: string;
  navSelector: string;
  mainSelector: string;
  lng: string;
  hideSelectors: string[];
};

type AccessibilityInitializer = (options: AccessibilityOptions) => void | Promise<void>;

declare const accessibility: AccessibilityInitializer | undefined;

declare global {
  interface Window {
    accessibility?: AccessibilityInitializer;
  }
}

let accessibilityStarted = false;

const TOOLBAR_SELECTOR = '.accessibility-controls.a11y-tools';
const INIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

function getAccessibilityInitializer() {
  if (typeof window.accessibility === 'function') {
    return window.accessibility;
  }
  if (typeof accessibility === 'function') {
    return accessibility;
  }
  return undefined;
}

export function AccessibilityWidget() {
  useEffect(() => {
    let stopped = false;
    let intervalId: number | undefined;
    const startedAt = Date.now();

    const stop = () => {
      stopped = true;
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
      }
      window.removeEventListener('load', tryInitialize);
    };

    function tryInitialize() {
      if (stopped) return true;
      if (accessibilityStarted || document.querySelector(TOOLBAR_SELECTOR)) {
        stop();
        return true;
      }
      const initialize = getAccessibilityInitializer();
      if (!initialize) {
        if (Date.now() - startedAt >= INIT_TIMEOUT_MS) {
          stop();
          return true;
        }
        return false;
      }

      accessibilityStarted = true;
      void Promise.resolve(
        initialize({
          parentSelector: 'body',
          navSelector: '.site-nav',
          mainSelector: 'main',
          lng: 'bg',
          hideSelectors: ['img', 'video', 'svg'],
        }),
      ).catch(() => undefined);
      stop();
      return true;
    }

    window.addEventListener('load', tryInitialize);
    tryInitialize();
    if (!stopped) {
      intervalId = window.setInterval(tryInitialize, POLL_INTERVAL_MS);
    }

    return stop;
  }, []);

  return null;
}
