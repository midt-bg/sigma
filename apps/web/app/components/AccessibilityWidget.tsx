// The accessibility toolbar is a vendored third-party script (Информационно обслужване АД) under
// public/assets/accessibility/. It has minor keyboard/ARIA rough edges this wrapper can't change
// without forking the script; they are catalogued in docs/accessibility.md ("Вградена приставка за
// достъпност — наблюдения"). This wrapper only initialises it and installs survival CSS.
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
@font-face{font-family:'adys';src:url(/assets/accessibility/ADYS-Regular-V5-4.ttf);font-weight:normal;font-style:normal}
html.a11y-textonly .sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;clip-path:inset(50%)!important;white-space:nowrap!important;border:0!important}
html.a11y-textonly .brand-sub{display:inline-block!important;font-weight:700!important;font-size:1.1em!important}
html.a11y-textonly .skip:not(:focus){position:absolute!important;left:-9999px!important;top:-9999px!important;width:1px!important;height:1px!important;overflow:hidden!important}
html.a11y-textonly img,html.a11y-textonly svg,html.a11y-textonly video{display:none!important}
html.a11y-textonly .ts-data-table{display:table!important;position:static!important;width:100%!important;height:auto!important;margin:0 0 12px!important;padding:0!important;overflow:auto!important;clip:auto!important;clip-path:none!important;white-space:normal!important;border-collapse:collapse!important}html.a11y-textonly .ts-data-table th,html.a11y-textonly .ts-data-table td{border:1px solid #bbb!important;padding:4px 8px!important;text-align:left!important}
html.a11y-textonly #filter-rail-toggle,html.a11y-textonly .filter-rail-toggle,html.a11y-textonly .filter-rail-summary,html.a11y-textonly .a11y-tools__button{display:none!important}
html.a11y-textonly :focus-visible{outline:3px solid #0a58ca!important;outline-offset:2px!important}
html.a11y-textonly .accessibility-controls.a11y-tools{display:block!important;position:static!important;border:2px solid #0a58ca!important;background:#eef4ff!important;color:#000!important;padding:8px!important;margin:0 0 12px!important;max-width:680px!important}
html.a11y-textonly .a11y-tools__nav{margin:0!important}
html.a11y-textonly .a11y-tools__title{font-weight:700!important;margin:4px 0!important}
html.a11y-textonly .a11y__item button,html.a11y-textonly .a11y__item__button,html.a11y-textonly .a11y-tools__contrast button{border:1px solid #333!important;background:#fff!important;color:#000!important;padding:4px 8px!important;margin:2px!important;cursor:pointer!important}
html.a11y-textonly body{max-width:1000px!important;margin:0 auto!important;padding:16px!important;line-height:1.5!important}
html.a11y-textonly .a11y-tools__list,html.a11y-textonly .accessibility-content ul{list-style:none!important;margin:0!important;padding:0!important}
html.a11y-textonly .a11y-tools__contrast{display:flex!important;flex-wrap:wrap!important;gap:6px!important;margin:4px 0 8px!important}
html.a11y-textonly .a11y__item{margin:4px 0!important}
html.a11y-textonly .site-header{border-bottom:1px solid #bbb!important;padding-bottom:10px!important;margin-bottom:16px!important}
html.a11y-textonly .brand{display:inline-block!important;margin-bottom:6px!important;text-decoration:none!important}
html.a11y-textonly .site-nav{display:flex!important;flex-wrap:wrap!important;gap:6px 20px!important;margin:8px 0!important}
html.a11y-textonly .site-nav a{display:inline-block!important;padding:2px 0!important}
html.a11y-textonly .site-actions{display:flex!important;flex-wrap:wrap!important;gap:18px!important;margin-top:10px!important}
html.a11y-textonly main{margin-top:8px!important}
html.a11y-textonly.font-resize,html.a11y-textonly .font-resize{font-size:200%!important}
@media(min-width:48em){html.a11y-textonly.font-resize,html.a11y-textonly .font-resize{font-size:110%!important}}
@media(min-width:62em){html.a11y-textonly.font-resize,html.a11y-textonly .font-resize{font-size:120%!important}}
@media(min-width:75em){html.a11y-textonly.font-resize,html.a11y-textonly .font-resize{font-size:130%!important}}
@media(min-width:87.5em){html.a11y-textonly.font-resize,html.a11y-textonly body.font-resize{font-size:140%!important}}
html.a11y-textonly.dyslectic-font,html.a11y-textonly.dyslectic-font *{font-family:'adys'!important}
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
