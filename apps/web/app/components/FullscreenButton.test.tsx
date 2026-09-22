// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FullscreenButton } from './FullscreenButton';

afterEach(cleanup);

describe('FullscreenButton', () => {
  it('offers to enter fullscreen while inactive and reports it unpressed', () => {
    const { getByRole } = render(<FullscreenButton active={false} onToggle={() => {}} />);
    const btn = getByRole('button');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Разгледай графиката на цял екран');
    expect(btn.textContent).toBe('Цял екран');
  });

  it('offers to exit while active and reports it pressed, with the corner arrows pointing inward', () => {
    const inactive = render(<FullscreenButton active={false} onToggle={() => {}} />);
    const enterPaths = Array.from(inactive.container.querySelectorAll('path')).map((p) =>
      p.getAttribute('d'),
    );
    cleanup();

    const { container, getByRole } = render(<FullscreenButton active onToggle={() => {}} />);
    const btn = getByRole('button');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('Изход от цял екран');
    expect(btn.getAttribute('title')).toBe('Изход от цял екран');
    expect(btn.textContent).toBe('Изход');
    const exitPaths = Array.from(container.querySelectorAll('path')).map((p) =>
      p.getAttribute('d'),
    );
    expect(exitPaths).toHaveLength(4);
    expect(exitPaths).not.toEqual(enterPaths);
  });

  it('calls onToggle once per click', () => {
    const onToggle = vi.fn();
    const { getByRole } = render(<FullscreenButton active={false} onToggle={onToggle} />);
    fireEvent.click(getByRole('button'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
