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

import { MetricInfo } from './MetricInfo';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MetricInfo', () => {
  it('reflects title, summary and readout verbatim into the accessible name', () => {
    const withReadout = render(<MetricInfo title="Т" summary="Обобщение." readout="Стойност 5" />);
    expect(withReadout.getByRole('button').getAttribute('aria-label')).toBe(
      'Т. Обобщение. Стойност 5',
    );
    expect(withReadout.container.querySelector('.metric-info-readout')?.textContent).toBe(
      'Стойност 5',
    );
    cleanup();
    const bare = render(<MetricInfo title="Т" summary="Обобщение." />);
    expect(bare.getByRole('button').getAttribute('aria-label')).toBe('Т. Обобщение.');
    expect(bare.container.querySelector('.metric-info-readout')).toBeNull();
  });

  it('anchors the popover to the end edge only when asked', () => {
    const start = render(<MetricInfo title="Т" summary="С" />);
    expect(start.container.querySelector('.metric-info-pop')?.className).not.toContain('is-end');
    cleanup();
    const end = render(<MetricInfo title="Т" summary="С" align="end" />);
    expect(end.container.querySelector('.metric-info-pop')?.className).toContain('is-end');
  });

  it('toggles open and closed on click and mirrors that in aria-expanded', () => {
    const { container, getByRole } = render(<MetricInfo title="Т" summary="С" />);
    const root = container.querySelector('.metric-info')!;
    const button = getByRole('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(root.className).toContain('is-open');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(button);
    expect(root.className).not.toContain('is-open');
  });

  it('closes on an outside pointerdown but not on one inside, and on Escape', () => {
    const { container, getByRole } = render(
      <div>
        <MetricInfo title="Т" summary="С" />
        <p data-testid="outside">elsewhere</p>
      </div>,
    );
    const root = container.querySelector('.metric-info')!;
    fireEvent.click(getByRole('button'));
    fireEvent.pointerDown(root.querySelector('.metric-info-title')!);
    expect(root.className).toContain('is-open');
    fireEvent.pointerDown(container.querySelector('[data-testid="outside"]')!);
    expect(root.className).not.toContain('is-open');

    fireEvent.click(getByRole('button'));
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(root.className).toContain('is-open');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(root.className).not.toContain('is-open');
  });

  it('shifts a popover that overflows either viewport edge back inside, and releases it on close', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 320,
    });
    const rect = { left: 200, right: 360 }; // 48px past the right inset
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => rect as DOMRect,
    );
    const { container, getByRole } = render(<MetricInfo title="Т" summary="С" />);
    const pop = container.querySelector('.metric-info-pop') as HTMLElement;
    fireEvent.click(getByRole('button'));
    expect(pop.style.translate).toBe('-48px 0');
    fireEvent.click(getByRole('button'));
    expect(pop.style.translate).toBe('');

    // Overflowing the left edge instead pushes it right.
    rect.left = -30;
    rect.right = 100;
    fireEvent.click(getByRole('button'));
    expect(pop.style.translate).toBe('38px 0');
  });

  it('leaves a popover that already fits untouched', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 1024,
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ left: 100, right: 300 }) as DOMRect,
    );
    const { container, getByRole } = render(<MetricInfo title="Т" summary="С" />);
    fireEvent.click(getByRole('button'));
    act(() => {});
    expect((container.querySelector('.metric-info-pop') as HTMLElement).style.translate).toBe('');
  });
});
