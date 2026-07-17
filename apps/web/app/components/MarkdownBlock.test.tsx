import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MarkdownBlock } from './MarkdownBlock';

afterEach(() => {
  cleanup();
});

describe('MarkdownBlock — XSS safety (no dangerouslySetInnerHTML, no raw-HTML passthrough)', () => {
  it('renders bold, italic, and code as React elements', () => {
    const { container } = render(<MarkdownBlock md="**bold** *italic* `code`" />);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelector('code')?.textContent).toBe('code');
  });

  it('does not inject raw HTML — angle brackets are text, not tags', () => {
    const { container } = render(<MarkdownBlock md="<script>alert(1)</script> hello" />);
    // The literal string must appear as text — no live <script> element.
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders safe https: links as anchors', () => {
    render(<MarkdownBlock md="[example](https://example.com)" />);
    const a = screen.getByRole('link', { name: 'example' });
    expect(a).toBeInTheDocument();
    expect(a.getAttribute('href')).toBe('https://example.com');
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('degrades javascript: href to plain text — no anchor rendered', () => {
    const { container } = render(<MarkdownBlock md="[click me](javascript:alert(1))" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('click me');
  });

  it('degrades data: href to plain text', () => {
    const { container } = render(<MarkdownBlock md="[xss](data:text/html,<h1>xss</h1>)" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('xss');
  });

  it('degrades protocol-relative // href to plain text', () => {
    const { container } = render(<MarkdownBlock md="[evil](//evil.com)" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('evil');
  });

  it('renders relative paths as anchors', () => {
    render(<MarkdownBlock md="[report](/reports/r_abc123)" />);
    const a = screen.getByRole('link', { name: 'report' });
    expect(a.getAttribute('href')).toBe('/reports/r_abc123');
  });

  it('splits on blank lines into paragraphs', () => {
    const { container } = render(<MarkdownBlock md={'paragraph one\n\nparagraph two'} />);
    const paras = container.querySelectorAll('p');
    expect(paras).toHaveLength(2);
    expect(paras[0].textContent).toBe('paragraph one');
    expect(paras[1].textContent).toBe('paragraph two');
  });

  it('returns null for empty / whitespace-only input', () => {
    const { container } = render(<MarkdownBlock md="   " />);
    expect(container.firstChild).toBeNull();
  });
});

describe('MarkdownBlock — block-level forms (lists, hr, tables)', () => {
  it('renders an unordered list', () => {
    const { container } = render(<MarkdownBlock md={'- едно\n- две'} />);
    const items = container.querySelectorAll('ul > li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe('едно');
    expect(items[1].textContent).toBe('две');
  });

  it('renders an ordered list (including multi-digit markers)', () => {
    const { container } = render(<MarkdownBlock md={'1. a\n2. b\n10. c'} />);
    const items = container.querySelectorAll('ol > li');
    expect(items).toHaveLength(3);
    expect(items[2].textContent).toBe('c');
  });

  it('renders inline markup inside list items', () => {
    const { container } = render(<MarkdownBlock md={'- **важно**'} />);
    expect(container.querySelector('li strong')?.textContent).toBe('важно');
  });

  it('renders a horizontal rule between paragraphs', () => {
    const { container } = render(<MarkdownBlock md={'преди\n\n---\n\nслед'} />);
    expect(container.querySelector('hr')).not.toBeNull();
    expect(container.querySelectorAll('p')).toHaveLength(2);
  });

  it('renders a GFM pipe table (header + delimiter + body)', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |';
    const { container } = render(<MarkdownBlock md={md} />);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(container.querySelectorAll('thead th')).toHaveLength(2);
    const bodyRows = container.querySelectorAll('tbody tr');
    expect(bodyRows).toHaveLength(2);
    expect(bodyRows[0].querySelectorAll('td')[0].textContent).toBe('1');
  });

  it('renders inline markup inside table cells', () => {
    const md = '| Име |\n| --- |\n| **X** |';
    const { container } = render(<MarkdownBlock md={md} />);
    expect(container.querySelector('tbody strong')?.textContent).toBe('X');
  });

  it('does NOT treat a pipe row without a delimiter row as a table (false-match guard)', () => {
    const { container } = render(<MarkdownBlock md={'| A | B |\nобикновен ред'} />);
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('| A | B |');
  });

  it('does NOT throw and renders text when a pipe row is the last line (streaming partial table)', () => {
    const { container } = render(<MarkdownBlock md={'| A | B |'} />);
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('| A | B |');
  });

  it('separates a paragraph immediately followed by a list (line-grouping, no blank line)', () => {
    const { container } = render(<MarkdownBlock md={'въведение\n- a\n- b'} />);
    const p = container.querySelector('p');
    expect(p?.textContent).toBe('въведение');
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
  });

  it('normalizes CRLF — no carriage return leaks into list items', () => {
    const { container } = render(<MarkdownBlock md={'- a\r\n- b'} />);
    const items = container.querySelectorAll('li');
    expect(items[0].textContent).toBe('a');
    expect(container.textContent).not.toContain('\r');
  });
});

describe('MarkdownBlock — XSS safety inside new block forms', () => {
  const hasExecutableHref = (container: HTMLElement): boolean =>
    Array.from(container.querySelectorAll('a')).some((a) =>
      /^\s*(javascript|data|vbscript):/i.test(a.getAttribute('href') ?? ''),
    );

  it('renders raw HTML in a table cell as inert text', () => {
    const md = '| <script>alert(1)</script> | b |\n| --- | --- |\n| c | d |';
    const { container } = render(<MarkdownBlock md={md} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders raw onerror img in a list item as inert text', () => {
    const { container } = render(<MarkdownBlock md={'- <img src=x onerror=alert(1)>'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('degrades a javascript: link inside a list item to text', () => {
    const { container } = render(<MarkdownBlock md={'- [клик](javascript:alert(1))'} />);
    expect(hasExecutableHref(container)).toBe(false);
    expect(container.textContent).toContain('клик');
  });

  it('never emits an executable href for an entity-encoded scheme in a cell', () => {
    const md = '| [x](javascript&#58;alert(1)) |\n| --- |\n| ok |';
    const { container } = render(<MarkdownBlock md={md} />);
    expect(hasExecutableHref(container)).toBe(false);
  });

  it('degrades a tab-split scheme in a cell (URL parser strips the tab)', () => {
    const md = '| [x](java\tscript:alert(1)) |\n| --- |\n| ok |';
    const { container } = render(<MarkdownBlock md={md} />);
    expect(hasExecutableHref(container)).toBe(false);
  });

  it('does not autolink a bare <https://…> in a cell (no autolink rule)', () => {
    const md = '| <https://evil.example> |\n| --- |\n| ok |';
    const { container } = render(<MarkdownBlock md={md} />);
    expect(container.querySelector('a')).toBeNull();
  });
});
