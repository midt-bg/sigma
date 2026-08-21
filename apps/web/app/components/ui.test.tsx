// @vitest-environment jsdom
// ui.tsx holds the shared editorial primitives. Every one takes an optional prop that switches a class
// or drops a subtree; those are exactly the branches the page-level render tests never reach (they only
// ever exercise whichever variant that page happens to use). Render each primitive both ways.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Callout, Chip, ExternalEikLink, Flag, OwnershipChip, Section, ShareBar } from './ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode) {
  act(() => {
    root.render(node);
  });
  return container;
}

describe('Chip', () => {
  it('emits a bare chip class with no tone and a toned modifier with one', () => {
    expect(render(<Chip>плайн</Chip>).querySelector('span')!.className).toBe('chip');
    expect(render(<Chip tone="strong">силен</Chip>).querySelector('span')!.className).toBe(
      'chip chip-strong',
    );
    expect(render(<Chip tone="window">прозорец</Chip>).querySelector('span')!.className).toBe(
      'chip chip-window',
    );
  });
});

describe('ExternalEikLink', () => {
  it('URL-encodes the ЕИК, opens in a new tab safely, and appends an optional class', () => {
    const a = render(<ExternalEikLink eik="123 456" />).querySelector('a')!;
    expect(a.getAttribute('href')).toContain('uic=123%20456'); // encoded, not raw
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer'); // no reverse-tabnabbing
    expect(a.className).toBe('external-eik-link');
    expect(a.getAttribute('aria-label')).toContain('123 456');

    const withClass = render(<ExternalEikLink eik="111" className="inline" />).querySelector('a')!;
    expect(withClass.className).toBe('external-eik-link inline');
  });
});

describe('OwnershipChip', () => {
  it('renders nothing when the ownership kind is absent', () => {
    expect(render(<OwnershipChip kind={null} />).querySelector('span')).toBeNull();
    expect(render(<OwnershipChip kind={undefined} />).querySelector('span')).toBeNull();
  });

  it('labels each ownership kind in Bulgarian', () => {
    expect(render(<OwnershipChip kind="state" />).textContent).toBe('държавно');
    expect(render(<OwnershipChip kind="municipal" />).textContent).toBe('общинско');
    expect(render(<OwnershipChip kind="mixed" />).textContent).toBe('държавно-общинско');
  });
});

describe('Flag', () => {
  it('emits a bare flag with no variant and a suffixed class with one', () => {
    expect(render(<Flag>гол</Flag>).querySelector('span')!.className).toBe('flag');
    for (const variant of ['soft', 'info', 'neutral'] as const) {
      expect(render(<Flag variant={variant}>x</Flag>).querySelector('span')!.className).toBe(
        `flag ${variant}`,
      );
    }
  });
});

describe('ShareBar', () => {
  it('clamps the fill width to 0–100% for out-of-range ratios', () => {
    // jsdom re-serialises the CSS length, so compare the numeric percentage, not the raw string.
    const fill = (ratio: number) =>
      parseFloat(
        (render(<ShareBar ratio={ratio} />).querySelector('.share-bar i') as HTMLElement).style
          .width,
      );
    expect(fill(-0.5)).toBe(0); // negative clamps to the floor
    expect(fill(2)).toBe(100); // over-unity clamps to the ceiling
    expect(fill(0.253)).toBe(25.3); // in range, one decimal
  });

  it('paints the warn variant and adds a screen-reader-only note only when warn is set', () => {
    const plain = render(<ShareBar ratio={0.4} />);
    expect(plain.querySelector('.share-bar')!.className).toBe('share-bar');
    expect(plain.querySelector('.sr-only')).toBeNull();

    const warned = render(<ShareBar ratio={0.9} warn />);
    expect(warned.querySelector('.share-bar')!.className).toBe('share-bar warn');
    expect(warned.querySelector('.sr-only')!.textContent).toContain('висок дял');
  });
});

describe('Callout', () => {
  it('omits the heading entirely when no title is given', () => {
    const el = render(<Callout>тяло</Callout>);
    expect(el.querySelector('h2, h3')).toBeNull();
    expect(el.querySelector('div')!.className).toBe('callout');
  });

  it('defaults the title to h3 and honours an explicit h2 (heading order)', () => {
    expect(render(<Callout title="Заглавие">тяло</Callout>).querySelector('h3')).not.toBeNull();
    expect(
      render(
        <Callout title="Заглавие" titleAs="h2">
          тяло
        </Callout>,
      ).querySelector('h2'),
    ).not.toBeNull();
  });

  it('suffixes the variant class when set', () => {
    expect(
      render(
        <Callout title="Внимание" variant="warning">
          тяло
        </Callout>,
      ).querySelector('div')!.className,
    ).toBe('callout warning');
  });
});

describe('Section', () => {
  it('wires the heading id to aria-labelledby and drops the hint when absent', () => {
    const el = render(
      <Section id="sec-1" title="Дял">
        тяло
      </Section>,
    );
    expect(el.querySelector('section')!.getAttribute('aria-labelledby')).toBe('sec-1');
    expect(el.querySelector('h2')!.id).toBe('sec-1');
    expect(el.querySelector('.section-hint')).toBeNull();
  });

  it('renders the hint paragraph when provided', () => {
    const el = render(
      <Section id="sec-2" title="Дял" hint="пояснение">
        тяло
      </Section>,
    );
    expect(el.querySelector('.section-hint')!.textContent).toBe('пояснение');
  });
});
