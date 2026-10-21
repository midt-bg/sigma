// @vitest-environment jsdom
// The vendored accessibility toolbar (public/assets/accessibility/accessibility.js) carries local
// accessibility fixes. Run the real script against a small page and check them: one trigger with
// aria-expanded is the only tab stop until the panel opens, Esc closes it and returns focus, the toggles
// report aria-pressed, the theme buttons' names contain their visible „C", both navs are named in
// Bulgarian, and a skip link focuses its target without making it a tab stop.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dir = resolve(__dirname, '../../public/assets/accessibility') + '/';
const source = readFileSync(`${dir}accessibility.js`, 'utf8');
const translations = JSON.parse(readFileSync(`${dir}translations.json`, 'utf8'));

type Init = (opts: Record<string, unknown>) => Promise<void>;

beforeEach(async () => {
  localStorage.clear();
  document.documentElement.className = '';
  document.body.className = '';
  document.body.innerHTML = `
    <script src="/assets/accessibility/accessibility.js"></script>
    <nav class="site-nav"><a href="/">Начало</a></nav>
    <main id="main"><h1>Заглавие</h1></main>`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ json: async () => translations })),
  );
  Element.prototype.scrollIntoView = vi.fn();
  const init = new Function(`${source}; return accessibility;`)() as Init;
  await init({ parentSelector: 'body', navSelector: '.site-nav', mainSelector: 'main', lng: 'bg' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const trigger = () => q<HTMLButtonElement>('.a11y-tools__button');
const escape = (from: Element) =>
  from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

describe('vendored accessibility toolbar', () => {
  it('has one named trigger and no focusable containers', () => {
    expect(q('.accessibility-controls').hasAttribute('tabindex')).toBe(false);
    expect(q('.a11y-tools__nav').hasAttribute('tabindex')).toBe(false);
    expect(trigger().hasAttribute('tabindex')).toBe(false);
    expect(trigger().textContent).toBe('Меню за достъпност');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-controls')).toBe(q('.a11y-tools__nav').id);
  });

  it('names both navs in Bulgarian', () => {
    expect(q('.a11y-tools__nav').getAttribute('aria-label')).toBe('Меню за достъпност');
    expect(q('.accessibility-content').getAttribute('aria-label')).toBe('Бързи връзки');
  });

  it('opens from the trigger and closes on Esc, returning focus to it', () => {
    trigger().click();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(q('.a11y-tools').classList.contains('is-open')).toBe(true);
    const inside = q<HTMLButtonElement>('.a11y__btn--dark');
    inside.focus();
    escape(inside);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(q('.a11y-tools').classList.contains('is-open')).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it('closes when focus leaves the toolbar', () => {
    trigger().click();
    trigger().focus();
    q<HTMLAnchorElement>('.site-nav a').focus();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('puts the visible „C" into each theme button name and reports the active theme', () => {
    const themes = [...document.querySelectorAll<HTMLButtonElement>('.a11y__btn--c')];
    expect(themes.map((b) => b.getAttribute('aria-label'))).toEqual([
      'C – Жълта тема',
      'C – Тъмна тема',
      'C – Синя тема',
      'C – Оригинална тема',
    ]);
    const pressed = () => themes.map((b) => b.getAttribute('aria-pressed'));
    expect(pressed()).toEqual(['false', 'false', 'false', 'true']);
    themes[0]!.click();
    expect(pressed()).toEqual(['true', 'false', 'false', 'false']);
    themes[3]!.click();
    expect(pressed()).toEqual(['false', 'false', 'false', 'true']);
  });

  it('runs a toggle from its button and reports its state', () => {
    const dyslexic = q<HTMLButtonElement>('.a11y__item--dyslexic button');
    expect(dyslexic.getAttribute('aria-pressed')).toBe('false');
    dyslexic.click();
    expect(document.body.classList.contains('dyslectic-font')).toBe(true);
    expect(dyslexic.getAttribute('aria-pressed')).toBe('true');
    q<HTMLButtonElement>('.a11y__item--clear button').click();
    expect(document.body.classList.contains('dyslectic-font')).toBe(false);
    expect(dyslexic.getAttribute('aria-pressed')).toBe('false');
  });

  it('focuses the skip-link target without making it a tab stop', () => {
    const toMain = [
      ...document.querySelectorAll<HTMLAnchorElement>('.accessibility-content a'),
    ].find((a) => a.textContent === 'КЪМ ОСНОВНОТО СЪДЪРЖАНИЕ')!;
    toMain.click();
    const main = q('main');
    expect(document.activeElement).toBe(main);
    expect(main.getAttribute('tabindex')).toBe('-1');
    expect(main.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });
});
