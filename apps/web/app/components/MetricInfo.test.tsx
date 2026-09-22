// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricInfo } from './MetricInfo';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MetricInfo', () => {
  it('toggles the popover open and closed on click', () => {
    const { container, getByRole } = render(<MetricInfo title="Title" summary="Summary" />);
    const root = container.querySelector('.metric-info');
    const button = getByRole('button');

    expect(root?.className).not.toContain('is-open');

    fireEvent.click(button);
    expect(root?.className).toContain('is-open');

    fireEvent.click(button);
    expect(root?.className).not.toContain('is-open');
  });

  it('actually hides the popover on close even though the click gave the button focus', () => {
    // Clicking a real <button> focuses it (jsdom mirrors Chrome/Firefox here, unlike
    // `fireEvent.click` which alone does NOT dispatch a focus event) — so this reproduces the case
    // where `.metric-info:focus-within .metric-info-pop` (components.css) would otherwise keep the
    // popover visible after `is-open` is removed. Assert real visibility (jsdom computed style via
    // the class list this codebase's CSS keys off), not just the `is-open` class.
    const { container, getByRole } = render(<MetricInfo title="Title" summary="Summary" />);
    const root = container.querySelector('.metric-info') as HTMLElement;
    const button = getByRole('button');

    fireEvent.click(button);
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(root.className).toContain('is-open');

    fireEvent.click(button);
    expect(root.className).not.toContain('is-open');
    // The regression: without an explicit blur on close, focus stays on `button` here, which would
    // keep `:focus-within` (and therefore visibility) active despite `is-open` being gone.
    expect(document.activeElement).not.toBe(button);
    expect(document.activeElement).not.toBe(root.querySelector('.metric-info-btn'));
  });

  it('closes a hover-opened popover on Escape', () => {
    const { container } = render(<MetricInfo title="Title" summary="Summary" />);
    const root = container.querySelector('.metric-info') as HTMLElement;

    fireEvent.mouseEnter(root);
    expect(root.className).not.toContain('is-dismissed');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(root.className).toContain('is-dismissed');
  });

  it('removes resize/scroll listeners on unmount that were added while visible', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const { getByRole, unmount } = render(<MetricInfo title="Title" summary="Summary" />);
    fireEvent.click(getByRole('button'));

    const countByType = (calls: unknown[][], type: string) =>
      calls.filter(([t]) => t === type).length;

    const addedResize = countByType(addSpy.mock.calls, 'resize');
    const addedScroll = countByType(addSpy.mock.calls, 'scroll');
    expect(addedResize).toBeGreaterThan(0);
    expect(addedScroll).toBeGreaterThan(0);

    unmount();

    const removedResize = countByType(removeSpy.mock.calls, 'resize');
    const removedScroll = countByType(removeSpy.mock.calls, 'scroll');
    expect(removedResize).toBe(addedResize);
    expect(removedScroll).toBe(addedScroll);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('reflects title, summary and readout verbatim into the accessible name, and omits an absent readout', () => {
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

  describe('viewport clamping', () => {
    function stubRect(left: number, right: number) {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        // Report the natural rect moved by whatever `translate` the component has applied, the way a
        // real browser would — this is what the idempotency subtraction in `recompute` undoes.
        const applied = parseFloat(this.style.translate) || 0;
        return { left: left + applied, right: right + applied } as DOMRect;
      });
    }

    it('shifts a popover that overflows the right edge back inside, and resets when closed', () => {
      Object.defineProperty(document.documentElement, 'clientWidth', {
        configurable: true,
        value: 320,
      });
      stubRect(200, 360); // 48px past the 312px (320 − 8 inset) limit
      const { container, getByRole } = render(<MetricInfo title="Т" summary="С" />);
      const pop = container.querySelector('.metric-info-pop') as HTMLElement;
      expect(pop.style.translate).toBe('');

      fireEvent.click(getByRole('button'));
      expect(pop.style.translate).toBe('-48px 0');

      fireEvent.click(getByRole('button')); // close → shift released
      expect(pop.style.translate).toBe('');
    });

    it('re-clamps on resize through one animation frame, without compounding the applied shift', () => {
      Object.defineProperty(document.documentElement, 'clientWidth', {
        configurable: true,
        value: 320,
      });
      stubRect(200, 360);
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
      const { container, getByRole } = render(<MetricInfo title="Т" summary="С" />);
      fireEvent.click(getByRole('button'));
      const pop = container.querySelector('.metric-info-pop') as HTMLElement;

      // A burst of resizes coalesces into a single scheduled frame.
      fireEvent(window, new Event('resize'));
      fireEvent(window, new Event('resize'));
      expect(frames).toHaveLength(1);
      act(() => frames[0]!(0));
      // Recomputed from the natural rect, not from the already-shifted one → still −48, not −96.
      expect(pop.style.translate).toBe('-48px 0');
    });

    it('cancels a pending frame when unmounted mid-burst', () => {
      const cancel = vi.spyOn(window, 'cancelAnimationFrame');
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 42);
      const { getByRole, unmount } = render(<MetricInfo title="Т" summary="С" />);
      fireEvent.click(getByRole('button'));
      fireEvent(window, new Event('scroll'));
      unmount();
      expect(cancel).toHaveBeenCalledWith(42);
    });
  });

  describe('dismissal', () => {
    it('closes a click-opened popover on an outside pointerdown but not on an inside one', () => {
      const { container, getByRole } = render(
        <div>
          <MetricInfo title="Т" summary="С" />
          <p data-testid="outside">elsewhere</p>
        </div>,
      );
      const root = container.querySelector('.metric-info') as HTMLElement;
      fireEvent.click(getByRole('button'));
      expect(root.className).toContain('is-open');

      fireEvent.pointerDown(root.querySelector('.metric-info-title')!);
      expect(root.className).toContain('is-open');

      fireEvent.pointerDown(container.querySelector('[data-testid="outside"]')!);
      expect(root.className).not.toContain('is-open');
    });

    it('blurs a keyboard-focused trigger on Escape and ignores other keys', () => {
      const { container, getByRole } = render(<MetricInfo title="Т" summary="С" />);
      const root = container.querySelector('.metric-info') as HTMLElement;
      const button = getByRole('button');
      act(() => button.focus());
      expect(document.activeElement).toBe(button);

      fireEvent.keyDown(document, { key: 'Enter' });
      expect(root.className).not.toContain('is-dismissed');
      expect(document.activeElement).toBe(button);

      fireEvent.keyDown(document, { key: 'Escape' });
      // Blurring drops :focus-within, so the popover hides for real and the transient dismissal
      // flag has already cleared again — the trigger just no longer holds focus.
      expect(document.activeElement).not.toBe(button);
      expect(root.className).not.toContain('is-open');
    });

    it('does not steal focus from an unrelated field when Escape dismisses a hover-only popover', () => {
      const { container } = render(
        <div>
          <MetricInfo title="Т" summary="С" />
          <input aria-label="other" />
        </div>,
      );
      const input = container.querySelector('input') as HTMLInputElement;
      act(() => input.focus());
      fireEvent.mouseEnter(container.querySelector('.metric-info')!);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(document.activeElement).toBe(input);
    });

    it('lets a dismissed popover reopen once the pointer has left and returned', () => {
      const { container } = render(<MetricInfo title="Т" summary="С" />);
      const root = container.querySelector('.metric-info') as HTMLElement;
      fireEvent.mouseEnter(root);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(root.className).toContain('is-dismissed');

      fireEvent.mouseLeave(root); // every trigger cleared → dismissal drops
      expect(root.className).not.toContain('is-dismissed');

      fireEvent.mouseEnter(root);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(root.className).toContain('is-dismissed'); // shown again, so Esc listens again
    });

    it('tracks keyboard focus and blur as a visibility trigger', () => {
      const { container, getByRole } = render(<MetricInfo title="Т" summary="С" />);
      const root = container.querySelector('.metric-info') as HTMLElement;
      const button = getByRole('button');
      fireEvent.focus(button);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(root.className).toContain('is-dismissed');
      fireEvent.blur(button);
      expect(root.className).not.toContain('is-dismissed');
    });
  });
});
