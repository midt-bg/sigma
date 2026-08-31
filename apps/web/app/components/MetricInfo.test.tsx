// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MetricInfo } from './MetricInfo';

describe('MetricInfo', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function getButton() {
    return container.querySelector('button.metric-info-btn') as HTMLButtonElement;
  }

  it('renders the aria-label from title + summary when no readout is given', () => {
    act(() => {
      root.render(<MetricInfo title="Индекс" summary="описание" />);
    });
    expect(getButton().getAttribute('aria-label')).toBe('Индекс. описание');
  });

  it('appends the readout to the aria-label when given', () => {
    act(() => {
      root.render(<MetricInfo title="Индекс" summary="описание" readout="42" />);
    });
    expect(getButton().getAttribute('aria-label')).toBe('Индекс. описание 42');
  });

  it('toggles the open state and aria-expanded on click', () => {
    act(() => {
      root.render(<MetricInfo title="t" summary="s" />);
    });
    expect(getButton().getAttribute('aria-expanded')).toBe('false');
    act(() => {
      getButton().click();
    });
    expect(getButton().getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.metric-info')?.className).toContain('is-open');
    act(() => {
      getButton().click();
    });
    expect(getButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on outside pointerdown', () => {
    act(() => {
      root.render(<MetricInfo title="t" summary="s" />);
    });
    act(() => {
      getButton().click();
    });
    expect(getButton().getAttribute('aria-expanded')).toBe('true');
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(getButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape key', () => {
    act(() => {
      root.render(<MetricInfo title="t" summary="s" />);
    });
    act(() => {
      getButton().click();
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(getButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('adds the is-end class when align is "end"', () => {
    act(() => {
      root.render(<MetricInfo title="t" summary="s" align="end" />);
    });
    expect(container.querySelector('.metric-info-pop')?.className).toContain('is-end');
  });
});
