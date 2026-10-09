// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Minimal render/query/fire helpers over react-dom (no @testing-library on this branch).
const mounted: { root: Root; container: HTMLElement }[] = [];
function render(ui: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(ui));
  return {
    container,
    getByRole: (role: string) =>
      container.querySelector(role === 'button' ? 'button' : `[role="${role}"]`)!,
    getByText: (t: string) =>
      [...container.querySelectorAll('*')].find(
        (e) => e.textContent === t && e.children.length === 0,
      )! as HTMLElement,
    getByTestId: (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement,
    unmount: () => act(() => root.unmount()),
  };
}
function cleanup() {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}
const fireEvent = Object.assign(
  (el: EventTarget, ev: Event) => act(() => void el.dispatchEvent(ev)),
  {
    click: (el: Element) => act(() => (el as HTMLElement).click()),
    keyDown: (el: EventTarget, init: KeyboardEventInit) =>
      act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))),
    pointerDown: (el: EventTarget) =>
      act(() => void el.dispatchEvent(new Event('pointerdown', { bubbles: true }))),
  },
);

import { FullscreenButton, useFullscreen } from './FullscreenButton';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (document as { fullscreenElement?: unknown }).fullscreenElement;
});

describe('FullscreenButton', () => {
  it('offers to enter fullscreen while inactive and reports it unpressed', () => {
    const { getByRole } = render(<FullscreenButton active={false} onToggle={() => {}} />);
    const btn = getByRole('button');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Разгледай графиката на цял екран');
    expect(btn.textContent).toBe('Цял екран');
  });

  it('offers to exit while active, with different corner arrows than the enter state', () => {
    const inactive = render(<FullscreenButton active={false} onToggle={() => {}} />);
    const enter = [...inactive.container.querySelectorAll('path')].map((p) => p.getAttribute('d'));
    cleanup();
    const { container, getByRole } = render(<FullscreenButton active onToggle={() => {}} />);
    const btn = getByRole('button');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('title')).toBe('Изход от цял екран');
    expect(btn.textContent).toBe('Изход');
    expect([...container.querySelectorAll('path')].map((p) => p.getAttribute('d'))).not.toEqual(
      enter,
    );
  });

  it('calls onToggle once per click', () => {
    const onToggle = vi.fn();
    const { getByRole } = render(<FullscreenButton active={false} onToggle={onToggle} />);
    fireEvent.click(getByRole('button'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('useFullscreen', () => {
  function Harness() {
    const fs = useFullscreen<HTMLDivElement>();
    return (
      <div ref={fs.ref} data-testid="target" data-fs={String(fs.isFullscreen)}>
        <button type="button" onClick={fs.toggle}>
          toggle
        </button>
      </div>
    );
  }
  const setFullscreenElement = (el: Element | null) =>
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: el });

  it('requests fullscreen on its own container when none is active', () => {
    const { getByText, getByTestId } = render(<Harness />);
    const request = vi.fn(() => Promise.resolve());
    getByTestId('target').requestFullscreen = request;
    fireEvent.click(getByText('toggle'));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejected request (denied by the browser) instead of leaking an unhandled rejection', async () => {
    const { getByText, getByTestId } = render(<Harness />);
    getByTestId('target').requestFullscreen = () => Promise.reject(new Error('denied'));
    fireEvent.click(getByText('toggle'));
    await Promise.resolve(); // let the .catch run; an unhandled rejection would fail the run
    expect(getByTestId('target').dataset.fs).toBe('false');
  });

  it('no-ops where the Fullscreen API is unavailable', () => {
    const { getByText, getByTestId } = render(<Harness />);
    getByTestId('target').requestFullscreen = undefined as never;
    expect(() => fireEvent.click(getByText('toggle'))).not.toThrow();
  });

  it('exits fullscreen when something is already fullscreen', () => {
    const { getByText, getByTestId } = render(<Harness />);
    const exit = vi.fn(() => Promise.resolve());
    document.exitFullscreen = exit;
    setFullscreenElement(getByTestId('target'));
    fireEvent.click(getByText('toggle'));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('tolerates a missing exitFullscreen', () => {
    const { getByText, getByTestId } = render(<Harness />);
    document.exitFullscreen = undefined as never;
    setFullscreenElement(getByTestId('target'));
    expect(() => fireEvent.click(getByText('toggle'))).not.toThrow();
  });

  it('reports fullscreen only while its own container is the fullscreen element', () => {
    const { getByTestId } = render(<Harness />);
    const target = getByTestId('target');
    expect(target.dataset.fs).toBe('false');

    setFullscreenElement(target);
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(target.dataset.fs).toBe('true');

    setFullscreenElement(document.body); // some other element took fullscreen
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(target.dataset.fs).toBe('false');
  });

  it('stays fullscreen when a descendant of its container took fullscreen', () => {
    const { getByTestId, getByText } = render(<Harness />);
    const target = getByTestId('target');

    setFullscreenElement(getByText('toggle'));
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(target.dataset.fs).toBe('true');
  });

  it('stops listening once unmounted', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(<Harness />);
    unmount();
    expect(remove.mock.calls.some(([t]) => t === 'fullscreenchange')).toBe(true);
  });

  it('does nothing when toggled before the ref is attached', () => {
    function Detached() {
      const fs = useFullscreen<HTMLDivElement>();
      return (
        <button type="button" onClick={fs.toggle}>
          go
        </button>
      );
    }
    const { getByText } = render(<Detached />);
    expect(() => fireEvent.click(getByText('go'))).not.toThrow();
  });
});
