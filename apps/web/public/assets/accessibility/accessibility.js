/**
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
  };

  const themeChange = (theme) => {
    const classlist = ['accessibility-yellow', 'accessibility-dark', 'accessibility-blue'];
    localStorage.setItem('accesibility.theme', theme);
    classlist.map((e) => html.classList.remove(e));
    if (theme) {
      html.classList.add('accessibility-' + theme);
    }
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
  };

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
  };
  const getSettings = () => {
    Number(localStorage.getItem('accesibility.fontSize')) && increaseFontSize();
    Number(localStorage.getItem('accesibility.dyslectic')) && toggleDyslexicFont(false);
    localStorage.getItem('accesibility.theme') &&
      themeChange(localStorage.getItem('accesibility.theme'));
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
      'aria-hidden': false,
      'aria-label': 'accessibility skip content navigation',
      tabIndex: 0,
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
            ef(
              'button',
              { class: c, 'aria-label': t, event: { type: 'click', callback: f } },
              ef('span', { 'aria-hidden': true }, 'C'),
            ),
          ),
        ),
      ),
      ...buttonsData.map(([c, t, f]) =>
        ef(
          'li',
          { class: c, event: { type: 'click', callback: f } },
          ef('button', { class: 'a11y__item__button' }, ef('span', {}, t)),
        ),
      ),
      ef(
        'li',
        { class: 'a11y__item a11y__item--credits' },
        ef('p', {}, translations[lng].logoText ?? '© Information Services Jsc'),
      ),
    ),
  );

  const controlPanel = ef(
    'div',
    { class: 'accessibility-controls a11y-tools', tabIndex: 0 },
    ef(
      'button',
      {
        class: 'a11y-tools__button',
        'aria-label': translations[lng]?.showAccessMenu,
        tabIndex: -1,
      },
      ef('div', { class: 'sr-only' }, translations[lng]?.accessMenu),
    ),
    controlPanelNav,
  );
  parent.insertAdjacentElement('afterbegin', controlPanel);

  const leftContent = ef(
    'nav',
    { class: 'accessibility-content' },
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
      ef(
        'li',
        { class: 'ally-click' },
        ef(
          'ul',
          {},
          ...[...document.querySelectorAll(linkSelector)].map((e) =>
            ef('li', {}, ef('a', { href: '#' }, e.textContent)),
          ),
        ),
      ),
    ),
  );
  parent.insertAdjacentElement('afterbegin', leftContent);
  [
    ...document.querySelector('.ally-click').querySelectorAll('li'),
    ...document.querySelectorAll('.a11y-def-click'),
  ].map((e, i) => {
    e.addEventListener('click', (ev) => {
      ev.preventDefault();

      const el = e.dataset.target
        ? document.querySelector(e.dataset.target)
        : document.querySelectorAll(linkSelector)[i];
      el.tabIndex = 0;
      el.focus();
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });

      el.addEventListener('blur', () => {
        el.removeAttribute('tabIndex');
      });
    });
  });
  getSettings();
};
