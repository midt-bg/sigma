// @vitest-environment jsdom
// The mobile nav drawer: opening it moves focus to its close control, Tab and Shift+Tab cycle inside it
// while it is open, and closing it with ×, Esc or the backdrop returns focus to „Меню". The toggle is
// inert while the drawer is open, so the return must happen after the drawer state is committed.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteHeader } from './SiteHeader';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;
let onWide: ((e: { matches: boolean }) => void) | undefined;

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => (onWide = cb),
    removeEventListener: vi.fn(),
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  router = createMemoryRouter([{ path: '*', Component: SiteHeader }]);
  act(() => root.render(<RouterProvider router={router} />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  router.dispose();
});

const toggle = () => container.querySelector<HTMLButtonElement>('button.nav-toggle')!;
const close = () => container.querySelector<HTMLButtonElement>('button.site-nav-close')!;
const links = () => [...container.querySelectorAll<HTMLAnchorElement>('nav.site-nav a')];
const key = (init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    document.activeElement!.dispatchEvent(e);
  });
  return e;
};

function open() {
  toggle().focus();
  act(() => toggle().click());
}

describe('SiteHeader nav drawer', () => {
  it('moves focus into the drawer when it opens', () => {
    open();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(close());
  });

  it('keeps Tab inside the open drawer', () => {
    open();
    const last = links().at(-1)!;
    last.focus();
    expect(key({ key: 'Tab' }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close());

    expect(key({ key: 'Tab', shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    // A Tab between the first and the last control is left to the browser.
    links()[0]!.focus();
    expect(key({ key: 'Tab' }).defaultPrevented).toBe(false);

    // Focus that slipped out of the drawer is pulled back in.
    (document.activeElement as HTMLElement).blur();
    expect(key({ key: 'Tab' }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close());
  });

  it.each([
    ['the close button', () => act(() => close().click())],
    ['Esc', () => key({ key: 'Escape' })],
    [
      'the backdrop',
      () => act(() => container.querySelector<HTMLElement>('.nav-backdrop')!.click()),
    ],
  ])('returns focus to „Меню" after closing with %s', (_, closeIt) => {
    open();
    const calls: (Element | null)[] = [];
    const focus = vi.spyOn(toggle(), 'focus').mockImplementation(function (this: HTMLElement) {
      calls.push(this.closest('[inert]'));
      HTMLElement.prototype.focus.call(this);
    });
    closeIt();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    // Focused once, and not while still inside the inert action bar (a browser would ignore that call).
    expect(calls).toEqual([null]);
    expect(document.activeElement).toBe(toggle());
    focus.mockRestore();
  });

  it('does not pull focus back to „Меню" when a nav link is followed', () => {
    open();
    const focus = vi.spyOn(toggle(), 'focus');
    act(() => links()[2]!.click());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(focus).not.toHaveBeenCalled();
  });
});

describe('SiteHeader search drawer and layout', () => {
  const searchToggle = () => container.querySelector<HTMLButtonElement>('button.nav-search')!;
  const drawer = () => container.querySelector<HTMLElement>('.search-drawer')!;
  const openSearch = () => {
    searchToggle().focus();
    act(() => searchToggle().click());
  };

  it('opens the search drawer with focus in the field and closes it on Esc', () => {
    openSearch();
    expect(searchToggle().getAttribute('aria-expanded')).toBe('true');
    expect(drawer().contains(document.activeElement)).toBe(true);
    key({ key: 'Escape' });
    expect(searchToggle().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(searchToggle());
  });

  // The search field closes its suggestions on the first Esc and marks the event handled; React
  // listens on the document in the app, so stopPropagation() alone does not keep it from the drawer.
  it('leaves the drawer open on an Esc the field already handled', () => {
    openSearch();
    const handled = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    act(() => {
      document.activeElement!.dispatchEvent(handled);
    });
    expect(searchToggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('closes the search drawer from its × and on a click outside it, not inside it', () => {
    openSearch();
    act(() => drawer().querySelector<HTMLInputElement>('input')!.click());
    expect(searchToggle().getAttribute('aria-expanded')).toBe('true');
    act(() => document.body.click());
    expect(searchToggle().getAttribute('aria-expanded')).toBe('false');

    openSearch();
    act(() => container.querySelector<HTMLButtonElement>('.search-drawer-close')!.click());
    expect(searchToggle().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(searchToggle());
  });

  it('ignores other keys and closes the nav drawer when the layout turns wide', () => {
    open();
    expect(key({ key: 'a' }).defaultPrevented).toBe(false);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    act(() => onWide!({ matches: false }));
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    act(() => onWide!({ matches: true }));
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('marks „Анализи" current on an analytics page and closes the drawer when it is followed', async () => {
    await act(() => router.navigate('/analytics'));
    const analytics = links().find((a) => a.textContent === 'Анализи')!;
    expect(analytics.getAttribute('aria-current')).toBe('page');
    open();
    act(() => analytics.click());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });
});

// Both header buttons are wired up on hydration; without JavaScript they would be dead controls.
describe('SiteHeader without JavaScript', () => {
  it('links to the search page in place of the search button', () => {
    const html = renderToString(<RouterProvider router={router} />);
    expect(html).toMatch(/<noscript><a class="nav-search" href="\/search" aria-label="Търсене">/);
  });

  it('hides the buttons and shows the menu as links when scripting is off', () => {
    const css = readFileSync(resolve(__dirname, '../styles/chrome.css'), 'utf8');
    const noScript = css.slice(css.indexOf('@media (scripting: none)'));
    expect(noScript).toMatch(/button\.nav-search\s*\{\s*display: none/);
    expect(noScript).toMatch(/\.site-nav\s*\{[^}]*visibility: visible/);
    expect(noScript).toMatch(/\.nav-toggle,[^{]*\{\s*display: none/);
  });
});
