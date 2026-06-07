import { useEffect } from 'react';

type AccessibilityOptions = {
  parentSelector: string;
  navSelector: string;
  mainSelector: string;
  lng: string;
  hideSelectors: string[];
  textVersionOnCallbacks?: Array<() => void>;
  textVersionOffCallbacks?: Array<() => void>;
};

type AccessibilityInitializer = (options: AccessibilityOptions) => void | Promise<void>;

declare const accessibility: AccessibilityInitializer | undefined;

declare global {
  interface Window {
    accessibility?: AccessibilityInitializer;
  }
}

let accessibilityStarted = false;
let survivalStyleSheet: CSSStyleSheet | undefined;

const TOOLBAR_SELECTOR = '.accessibility-controls.a11y-tools';
const SURVIVAL_STYLE_ID = 'a11y-survival';
const INIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;
const SURVIVAL_CSS = `
html.a11y-textonly .sr-only{display:none!important;position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;clip-path:inset(50%)!important;white-space:nowrap!important;border:0!important}
html.a11y-textonly .brand-sub{display:none!important}
html.a11y-textonly .skip:not(:focus){position:absolute!important;left:-9999px!important;top:-9999px!important;width:1px!important;height:1px!important;overflow:hidden!important}
html.a11y-textonly img,html.a11y-textonly svg,html.a11y-textonly video{display:none!important}
html.a11y-textonly #filter-rail-toggle,html.a11y-textonly .filter-rail-toggle,html.a11y-textonly .filter-rail-summary,html.a11y-textonly .a11y-tools__button{display:none!important}
html.a11y-textonly :focus-visible{outline:3px solid #0a58ca!important;outline-offset:2px!important}
html.a11y-textonly .accessibility-controls.a11y-tools{display:block!important;position:static!important;border:2px solid #0a58ca!important;background:#eef4ff!important;color:#000!important;padding:8px!important;margin:0 0 12px!important;max-width:680px!important}
html.a11y-textonly .a11y-tools__nav{margin:0!important}
html.a11y-textonly .a11y-tools__title{font-weight:700!important;margin:4px 0!important}
html.a11y-textonly .a11y__item button,html.a11y-textonly .a11y__item__button,html.a11y-textonly .a11y-tools__contrast button{border:1px solid #333!important;background:#fff!important;color:#000!important;padding:4px 8px!important;margin:2px!important;cursor:pointer!important}
`;

function getAccessibilityInitializer() {
  if (typeof window.accessibility === 'function') {
    return window.accessibility;
  }
  if (typeof accessibility === 'function') {
    return accessibility;
  }
  return undefined;
}

function installAccessibilitySurvivalStyles() {
  if (
    'adoptedStyleSheets' in document &&
    typeof CSSStyleSheet === 'function' &&
    'replaceSync' in CSSStyleSheet.prototype
  ) {
    if (!survivalStyleSheet) {
      survivalStyleSheet = new CSSStyleSheet();
      survivalStyleSheet.replaceSync(SURVIVAL_CSS);
    }

    if (!document.adoptedStyleSheets.includes(survivalStyleSheet)) {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, survivalStyleSheet];
    }
    return;
  }

  let style = document.getElementById(SURVIVAL_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = SURVIVAL_STYLE_ID;
    style.textContent = SURVIVAL_CSS;
    document.head.appendChild(style);
  }
  if (style.sheet) {
    style.sheet.disabled = false;
  }
}

function activateTextOnlyMarker() {
  document.documentElement.classList.add('a11y-textonly');
  installAccessibilitySurvivalStyles();
}

function deactivateTextOnlyMarker() {
  document.documentElement.classList.remove('a11y-textonly');
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
      installAccessibilitySurvivalStyles();
      void Promise.resolve(
        initialize({
          parentSelector: 'body',
          navSelector: '.site-nav',
          mainSelector: 'main',
          lng: 'bg',
          hideSelectors: ['img', 'video', 'svg'],
          textVersionOnCallbacks: [activateTextOnlyMarker],
          textVersionOffCallbacks: [deactivateTextOnlyMarker],
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
