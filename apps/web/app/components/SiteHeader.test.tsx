// @vitest-environment jsdom
// The mobile nav drawer: opening it moves focus to its close control, Tab and Shift+Tab cycle inside it
// while it is open, and closing it with ×, Esc or the backdrop returns focus to „Меню". The toggle is
// inert while the drawer is open, so the return must happen after the drawer state is committed.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteHeader } from './SiteHeader';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
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
