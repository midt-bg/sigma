/**
 * Vendored from the ИО АД accessibility toolbar v1.0.2, with local accessibility fixes (see
 * docs/accessibility.md, „Вградена приставка за достъпност"): one trigger button with aria-expanded
 * opens the panel (Esc or leaving it closes it), the closed panel is out of the tab order, the toggles
 * report aria-pressed, the theme buttons' names contain their visible „C", both navs are named in the
 * page language, the click handlers sit on the buttons, and a skip link focuses its target without
 * making it a tab stop or scrolling it to the middle. The original theme removes the stored theme
 * instead of storing "null", and the list of headings can be rebuilt after a client-side navigation
 * (window.accessibilityRefreshHeadings).
 *
 * @param {object} opts - options object
 * opts.parentSelector - selector to get parent to inject tool into
 *
 * opts.navSelector - selector for anchor to navbar from left context menu
 *
 * opts.mainSelector - selector for anchor to main content from left context menu
 *
 * opts.linkSelector - selector for creating additional links to those elements in left context menu - default is "h1"
 *
 * opts.Lng - key for translations, additional can be added in translations.json
 *
 * opts.hideSelectors - hides elements with those selectors when text only is activate - default is ['img']
 * opts.textVersionOnCallbacks - call functions in array when activating textOnly
 * opts.textVersionOffCallbacks - call functions in array when deactivating textOnly
 *
 * @param  {string} opts.parentSelector - selector to get parent to inject tool into
 * @param  {string} opts.navSelector - selector for anchor to navbar from left context menu
 * @param  {string} opts.mainSelector - selector for anchor to main content from left context menu
 * @param  {string} opts.linkSelector - selector for creating additional links to those elements in left context menu - default is "h1"
 * @param  {boolean} opts.lng - key for translations, additional can be added in translations.json
 * @param  {string[]} opts.hideSelectors - hides elements with those selectors when text only is activate - default is ['img']
 * @param  {function[]} opts.textVersionOnCallbacks  - call functions in array when activating textOnly
 * @param  {function[]} opts.textVersionOffCallbacks  - call functions in array when deactivating textOnly
 */
const accessibility = async (opts) => {
  let {
    parentSelector,
    navSelector,
    mainSelector,
    linkSelector = 'h1',
    lng = document.querySelector('html').getAttribute('lang'),
    hideSelectors = ['img'],
    textVersionOnCallbacks = [],
    textVersionOffCallbacks = [],
  } = opts;

  function ef(type, attr, ...children) {
    const el = document.createElement(type);

    for (const key in attr) {
      if (key === 'event') {
        if (Array.isArray(attr[key])) {
          attr[key].map(function ({ type, callback }) {
            el.addEventListener(type, callback);
          });
        } else {
          el.addEventListener(attr[key].type, attr[key].callback);
        }
      } else {
        el.setAttribute(key, attr[key]);
      }
    }

    children.map(function (child) {
      if (typeof child === 'string' || typeof child === 'number') {
        el.appendChild(document.createTextNode(child));
      } else {
        el.appendChild(child);
      }
    });
    return el;
  }
  if (!parentSelector || !navSelector || !mainSelector) {
    throw new Error('"parentSelector" or "navSelector" or "mainSelector" are not set');
  }
  let translations = { [lng]: {} };
  const url = [...document.getElementsByTagName('script')]
    .find((e) => e.src.match(/accessibility.*.js/))
    .src.replace(/accessibility[^\/]*.js/, 'translations.json');

  try {
    const res = await fetch(url);
    translations = await res.json();
  } catch (error) {
    console.log(new Error('Transalations could not be loaded!!!'));
  }
  translations = new Proxy(translations, {
    get(target, prop) {
      if (typeof target[lng] === 'object' && target[lng] !== null)
        return new Proxy(target[prop], {
          get(target, prop) {
            return target[prop] ? target[prop] : `translations.${lng}.${prop}`;
          },
        });
    },
  });

  const parent = document.querySelector(parentSelector);
  const hideSelectorsElements = hideSelectors.flatMap((e) => [...document.querySelectorAll(e)]);
  const html = document.querySelector('html');
  const body = document.querySelector('body');
  const main = document.querySelector(mainSelector);
  const nav = document.querySelector(navSelector);
  if (!parent || !main || !nav) {
    throw new Error(
      `ACCESSIBILITY-TOOL: Element not found for 1 or more selectors : ${parentSelector}, ${navSelector}, ${mainSelector}`,
    );
  }
  const links = document.querySelectorAll(linkSelector).length;
  if (!links) {
    console.warn(`ACCESSIBILITY-TOOL: No link elements found with selector ${linkSelector}`);
  }
  const increaseFontSize = (e) => {
    html.classList.toggle('font-resize');
    body.classList.toggle('font-resize');
    localStorage.setItem('accesibility.fontSize', Number(body.classList.contains('font-resize')));
    syncPressed();
    document.querySelector('.a11y__item--increase').querySelector('span').textContent =
      body.classList.contains('font-resize')
        ? translations[lng]?.fontDown
        : translations[lng]?.fontUp;
  };

  const toggleDyslexicFont = (shoudExecute) => {
    html.classList.toggle('dyslectic-font');
    body.classList.toggle('dyslectic-font');
    localStorage.setItem(
      'accesibility.dyslectic',
      Number(body.classList.contains('dyslectic-font')),
    );
    syncPressed();
  };

  const themeChange = (theme) => {
    const classlist = ['accessibility-yellow', 'accessibility-dark', 'accessibility-blue'];
    // The original theme is no theme: drop the key rather than storing the string "null".
    if (theme) localStorage.setItem('accesibility.theme', theme);
    else localStorage.removeItem('accesibility.theme');
    classlist.map((e) => html.classList.remove(e));
    if (theme) {
      html.classList.add('accessibility-' + theme);
    }
    syncPressed();
  };
  let textOnly = { v: 0 };
  const textVersion = () => {
    for (let i = 0; i < document.styleSheets.length; i++) {
      if (document.styleSheets.item(i)) {
        textOnly.v
          ? (document.styleSheets.item(i).disabled = false)
          : (document.styleSheets.item(i).disabled = !document.styleSheets.item(i).disabled);
      }
    }
    textOnly.v = textOnly.v ? 0 : 1;
    localStorage.setItem('accesibility.textOnly', textOnly.v);

    if (textOnly.v) {
      hideSelectorsElements.map((e) => (e.style.display = 'none'));

      textVersionOnCallbacks.filter((cb) => typeof cb === 'function').map((cb) => cb());
    } else {
      hideSelectorsElements.map((e) => (e.style.display = ''));
      textVersionOffCallbacks.filter((cb) => typeof cb === 'function').map((cb) => cb());
    }
    syncPressed();
  };

  // aria-pressed mirrors what is on: the active theme (none = the original) and the on/off toggles.
  // The font-size button is left out — its label already flips between „увеличи" and „намали".
  function syncPressed() {
    const pressed = {
      'a11y__btn--yellow': html.classList.contains('accessibility-yellow'),
      'a11y__btn--dark': html.classList.contains('accessibility-dark'),
      'a11y__btn--blue': html.classList.contains('accessibility-blue'),
      'a11y__btn--clear': !/\baccessibility-(yellow|dark|blue)\b/.test(html.className),
      'a11y__item--dyslexic': body.classList.contains('dyslectic-font'),
      'a11y__item--textonly': Boolean(textOnly.v),
    };
    for (const cls in pressed) {
      const button = document.querySelector(`.${cls}`);
      const target =
        button && button.tagName === 'BUTTON' ? button : button?.querySelector('button');
      target?.setAttribute('aria-pressed', String(pressed[cls]));
    }
  }

  const reset = () => {
    themeChange(null);
    html.classList.remove('dyslectic-font');
    body.classList.remove('dyslectic-font');
    html.classList.remove('font-resize');
    body.classList.remove('font-resize');
    if (textOnly.v) {
      textVersion();
    }
    const lc = ['fontSize', 'dyslectic', 'theme', 'textOnly'];
    lc.map((e) => {
      localStorage.removeItem('accesibility.' + e);
    });
    syncPressed();
  };
  const getSettings = () => {
    Number(localStorage.getItem('accesibility.fontSize')) && increaseFontSize();
    Number(localStorage.getItem('accesibility.dyslectic')) && toggleDyslexicFont(false);
    // Earlier versions stored the original theme as the string "null".
    const theme = localStorage.getItem('accesibility.theme');
    theme && theme !== 'null' && themeChange(theme);
    Number(localStorage.getItem('accesibility.textOnly')) && textVersion();
  };
  const buttonsData = [
    [
      'a11y__item a11y__item--increase',
      Number(localStorage.getItem('accesibility.fontSize'))
        ? translations[lng]?.fontDown
        : translations[lng]?.fontUp,
      increaseFontSize,
    ],
    ['a11y__item a11y__item--dyslexic', translations[lng]?.dyslexic, toggleDyslexicFont],
    [
      'a11y__item a11y__item--textonly',
      translations[lng]?.text,
      textVersion.bind(null, textOnly.v),
    ],
    ['a11y__item a11y__item--clear', translations[lng]?.reset, reset],
  ];
  const themeButtonsData = [
    [
      'a11y__btn a11y__btn--c a11y__btn--yellow',
      translations[lng]?.yellow,
      themeChange.bind(null, 'yellow'),
    ],
    [
      'a11y__btn a11y__btn--c a11y__btn--dark',
      translations[lng]?.dark,
      themeChange.bind(null, 'dark'),
    ],
    [
      'a11y__btn a11y__btn--c a11y__btn--blue',
      translations[lng]?.blue,
      themeChange.bind(null, 'blue'),
    ],
    [
      'a11y__btn a11y__btn--c a11y__btn--clear',
      translations[lng]?.default,
      themeChange.bind(null, null),
    ],
  ];

  const controlPanelNav = ef(
    'nav',
    {
      class: 'a11y-tools__nav',
      id: 'a11y-tools-panel',
      'aria-label': translations[lng].accessMenu,
    },
    ef(
      'ul',
      { class: 'a11y-tools__list' },
      ef(
        'li',
        {},
        ef('div', { class: 'a11y-tools__title' }, translations[lng].changeContrast),
        ef(
          'div',
          {
            class: 'a11y-tools__contrast',
            role: 'group',
            'aria-label': translations[lng].changeContrast,
          },
          ...themeButtonsData.map(([c, t, f]) =>
            // The visible „C" is part of the name (WCAG 2.5.3), so „C" can be spoken to press it.
            ef(
              'button',
              { class: c, 'aria-label': `C – ${t}`, event: { type: 'click', callback: f } },
              ef('span', { 'aria-hidden': true }, 'C'),
            ),
          ),
        ),
      ),
      ...buttonsData.map(([c, t, f]) =>
        ef(
          'li',
          { class: c },
          ef(
            'button',
            { class: 'a11y__item__button', event: { type: 'click', callback: f } },
            ef('span', {}, t),
          ),
        ),
      ),
      ef(
        'li',
        { class: 'a11y__item a11y__item--credits' },
        ef('p', {}, translations[lng].logoText ?? '© Information Services Jsc'),
      ),
    ),
  );

  // One tab stop: the trigger. The panel is out of the tab order until the trigger opens it.
  const trigger = ef(
    'button',
    {
      type: 'button',
      class: 'a11y-tools__button',
      'aria-expanded': 'false',
      'aria-controls': 'a11y-tools-panel',
    },
    ef('span', { class: 'sr-only' }, translations[lng]?.accessMenu),
  );
  const controlPanel = ef(
    'div',
    { class: 'accessibility-controls a11y-tools' },
    trigger,
    controlPanelNav,
  );
  const setOpen = (open) => {
    controlPanel.classList.toggle('is-open', open);
    trigger.setAttribute('aria-expanded', String(open));
  };
  trigger.addEventListener('click', () =>
    setOpen(trigger.getAttribute('aria-expanded') !== 'true'),
  );
  controlPanel.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || trigger.getAttribute('aria-expanded') !== 'true') return;
    setOpen(false);
    trigger.focus();
  });
  controlPanel.addEventListener('focusout', (ev) => {
    if (!controlPanel.contains(ev.relatedTarget)) setOpen(false);
  });
  parent.insertAdjacentElement('afterbegin', controlPanel);

  // The links to the page's headings. A client-side navigation swaps the headings without reloading
  // the script, so the site's wrapper calls window.accessibilityRefreshHeadings after each one.
  const headingList = ef('ul', {});
  const renderHeadingLinks = () =>
    headingList.replaceChildren(
      ...[...document.querySelectorAll(linkSelector)].map((e) =>
        ef('li', {}, ef('a', { href: '#' }, e.textContent)),
      ),
    );
  renderHeadingLinks();
  window.accessibilityRefreshHeadings = renderHeadingLinks;
  const leftContent = ef(
    'nav',
    { class: 'accessibility-content', 'aria-label': translations[lng].skipLinks },
    ef(
      'ul',
      { class: 'innerUl' },
      ef(
        'li',
        { 'data-target': navSelector, class: 'a11y-def-click' },
        ef('a', { href: '#' }, translations[lng].toNav),
      ),
      ef(
        'li',
        { 'data-target': mainSelector, class: 'a11y-def-click' },
        ef('a', { href: '#' }, translations[lng].toMain),
      ),
      ef('li', { class: 'ally-click' }, headingList),
    ),
  );
  parent.insertAdjacentElement('afterbegin', leftContent);
  const jumpTo = (el) => {
    if (!el) return;
    // -1, not 0: the target takes focus without becoming a tab stop; scroll its start into view,
    // not its middle (a tall <main> would land the reader far down the page).
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });

    el.addEventListener('blur', () => {
      el.removeAttribute('tabIndex');
    });
  };
  document.querySelectorAll('.a11y-def-click').forEach((e) => {
    e.addEventListener('click', (ev) => {
      ev.preventDefault();
      jumpTo(document.querySelector(e.dataset.target));
    });
  });
  // One listener for the heading links, which are rebuilt: the n-th link goes to the n-th heading.
  headingList.addEventListener('click', (ev) => {
    const li = ev.target.closest('li');
    if (!li) return;
    ev.preventDefault();
    jumpTo(document.querySelectorAll(linkSelector)[[...headingList.children].indexOf(li)]);
  });
  getSettings();
  syncPressed();
};
