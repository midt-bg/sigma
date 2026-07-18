// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricInfo } from './MetricInfo';

afterEach(cleanup);

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

  it('closes a hover-opened popover on Escape', () => {
    const { container, getByRole } = render(<MetricInfo title="Title" summary="Summary" />);
    const root = container.querySelector('.metric-info') as HTMLElement;
    const button = getByRole('button');

    fireEvent.mouseEnter(root);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
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
});
